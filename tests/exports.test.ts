// P08 / FR-08: manual export — same server-side selection and columns for XLSX and Google «Import».
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { setup, type TestApp } from './helpers';

/** read a STORE/DEFLATE zip → name → text */
function unzip(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  while (p + 30 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extra = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(buf.subarray(p + 30, p + 30 + nameLen));
    const data = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    out[name] = new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data);
    p += 30 + nameLen + extra + size;
  }
  return out;
}

async function xlsxOf(app: TestApp, cookie: string, query: string) {
  const r = await app.call('POST', '/api/exports/xlsx', { query }, cookie);
  assert.equal(r.status, 200, typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body));
  return r;
}

async function rawXlsx(app: TestApp, cookie: string, query: string) {
  const res = await app.raw('POST', '/api/exports/xlsx', { query }, cookie);
  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzip(buf);
  const sheet = files['xl/worksheets/sheet1.xml'];
  const rows = sheet.match(/<row /g)?.length ?? 0;
  return { res, files, sheet, rows };
}

describe('export', () => {
  test('XLSX: all rows of the server-side filter (not a UI page), header + one row per task, formulas stay text', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await app.call('POST', '/api/features', { title: '=HYPERLINK("http://evil","x")', task_kind: 'bug' }, pm);
    const list = (await app.call('GET', '/api/features?hide_closed=1', undefined, pm)).body.total;
    const pv = await app.call('POST', '/api/exports/preview', { query: 'hide_closed=1' }, pm);
    assert.equal(pv.body.count, list);
    const x = await rawXlsx(app, pm, 'hide_closed=1');
    assert.equal(x.res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(x.rows, list + 1);
    assert.ok(x.files['[Content_Types].xml'] && x.files['xl/workbook.xml']);
    assert.ok(x.sheet.includes('<t xml:space="preserve">=HYPERLINK(&quot;http://evil&quot;,&quot;x&quot;)</t>'), 'formula exported as an inline string');
    assert.ok(!x.sheet.includes('<f>'), 'no formula cells at all');
    const kinds = await app.call('POST', '/api/exports/preview', { query: 'kind=bug' }, pm);
    assert.equal(kinds.body.count, 1);
    // audit + export run
    assert.ok(app.one("SELECT 1 AS ok FROM export_runs WHERE target = 'xlsx' AND status = 'done' AND row_count = ?", list));
    assert.ok(app.one("SELECT 1 AS ok FROM audit_log WHERE entity_type = 'export' AND action = 'xlsx'"));
  });

  test('hidden Product tasks never leave with a lead or guest, whatever the query (T03)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const hidden = (await app.call('POST', '/api/features', { title: 'Скрытая для экспорта', is_product_internal: true }, pm)).body;
    for (const q of ['internal=all', 'internal=1', `q=${encodeURIComponent('Скрытая')}`, '']) {
      const x = await rawXlsx(app, lead, q);
      assert.ok(!x.sheet.includes('Скрытая для экспорта') && !x.sheet.includes(hidden.key), `lead query «${q}»`);
    }
    assert.equal((await app.call('POST', '/api/exports/xlsx', { query: '' }, null)).status, 401);
    const own = await rawXlsx(app, pm, 'internal=1');
    assert.ok(own.sheet.includes('Скрытая для экспорта'));
    // one column set for everyone: the TaskFlow layout
    const head = (await app.call('POST', '/api/exports/preview', { query: '' }, lead)).body.columns;
    assert.deepEqual(head, (await app.call('POST', '/api/exports/preview', { query: '' }, pm)).body.columns);
  });

  test('Google: only the configured spreadsheet, only the «Import» tab, one atomic batchUpdate, confirmations, roles (T14, T15)', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    app.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'roadmap@project.iam.gserviceaccount.com', private_key: pem });
    const calls: { url: string; body?: any }[] = [];
    app.env.__FETCH = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('oauth2')) {
        const claims = JSON.parse(Buffer.from(decodeURIComponent(String(init?.body).split('assertion=')[1]).split('.')[1], 'base64url').toString());
        assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
        return new Response(JSON.stringify({ access_token: 'w', expires_in: 3600 }), { status: 200 });
      }
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.includes(':batchUpdate')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 0, title: 'Данные' } }, { properties: { sheetId: 77, title: 'Import', gridProperties: { rowCount: 5, columnCount: 3 } } }] }), { status: 200 });
    }) as typeof fetch;

    assert.equal((await app.call('POST', '/api/exports/google', { query: '' }, pm)).status, 400, 'not configured yet');
    assert.equal((await app.call('PUT', '/api/admin/settings', { export_google_spreadsheet_id: 'https://docs.google.com/spreadsheets/d/1ExportTargetSpreadsheetId0000000000000/edit' }, admin)).status, 200);
    assert.equal((await app.call('POST', '/api/exports/google', { query: '', confirm_external: true }, lead)).status, 403, 'role not allowed by default');
    const noConfirm = await app.call('POST', '/api/exports/google', { query: 'hide_closed=1' }, pm);
    assert.equal(noConfirm.status, 409);
    assert.equal(noConfirm.body.error.code, 'confirm_external');
    assert.equal(calls.length, 0, 'nothing written without confirmation');

    const ok = await app.call('POST', '/api/exports/google', { query: 'hide_closed=1', confirm_external: true }, pm);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const writes = calls.filter((c) => c.url.includes(':batchUpdate'));
    assert.equal(writes.length, 1, 'one atomic batchUpdate');
    assert.ok(writes[0].url.includes('1ExportTargetSpreadsheetId0000000000000'));
    const reqs = writes[0].body.requests;
    assert.ok(reqs.every((x: any) => JSON.stringify(x).includes('"sheetId":77')), 'only the Import tab (sheetId 77) is addressed');
    const data = reqs.find((x: any) => x.updateCells?.rows).updateCells.rows;
    // same selection and columns as XLSX
    const x = await rawXlsx(app, pm, 'hide_closed=1');
    assert.equal(data.length, x.rows);
    const head = (await app.call('POST', '/api/exports/preview', { query: 'hide_closed=1' }, pm)).body.columns;
    assert.deepEqual(data[0].values.map((v: any) => v.userEnteredValue?.stringValue), head);
    assert.ok(!JSON.stringify(data).includes('formulaValue'));

    // hidden tasks need a second confirmation; concurrent run is refused
    await app.call('POST', '/api/features', { title: 'Скрытая', is_product_internal: true }, pm);
    const internal = await app.call('POST', '/api/exports/google', { query: 'internal=all', confirm_external: true }, pm);
    assert.equal(internal.body.error.code, 'confirm_internal');
    app.many("INSERT INTO export_runs (id, target, query, status, created_at) VALUES ('busy', 'google', '', 'running', ?) RETURNING 1", new Date().toISOString());
    assert.equal((await app.call('POST', '/api/exports/google', { query: '', confirm_external: true }, pm)).body.error.code, 'export_running');
    // the Import tab missing → error, nothing written
    app.many("DELETE FROM export_runs WHERE id = 'busy' RETURNING 1");
    const before = calls.filter((c) => c.url.includes(':batchUpdate')).length;
    app.env.__FETCH = (async (url: string) => (String(url).includes('oauth2')
      ? new Response(JSON.stringify({ access_token: 'w', expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 0, title: 'Данные' } }] }), { status: 200 }))) as typeof fetch;
    const noTab = await app.call('POST', '/api/exports/google', { query: '', confirm_external: true }, pm);
    assert.equal(noTab.body.error.code, 'google_no_import_tab');
    assert.equal(calls.filter((c) => c.url.includes(':batchUpdate')).length, before);
    assert.ok(app.one("SELECT 1 AS ok FROM export_runs WHERE target = 'google' AND status = 'failed'"));
  });

  test('columns follow the TaskFlow sheet; unknown values stay empty', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const be = app.one("SELECT id FROM resource_teams WHERE code = 'backend'").id;
    const pr = app.one("SELECT id FROM resource_teams WHERE code = 'product'").id;
    const cat = app.one('SELECT id, name FROM categories LIMIT 1');
    const full = (await app.call('POST', '/api/features', { title: 'Полная', description: 'Комментарий к задаче\n\nФакт: 6 ч', category_id: cat.id, assignee_name: 'Азат Резяпов', estimates: { [be]: 3, [pr]: 2 }, tags: ['P2', 'влетевшая'] }, pm)).body.id;
    app.many("UPDATE features SET planned_end = '2026-10-23', baseline_production_date = '2026-10-19', closed_at = '2026-10-22', status_id = (SELECT id FROM statuses WHERE entity = 'feature' AND semantic = 'done' LIMIT 1) WHERE id = ? RETURNING 1", full);
    const bare = (await app.call('POST', '/api/features', { title: 'Пустая' }, pm)).body.id;
    const x = await rawXlsx(app, pm, `ids=${full},${bare}`);
    const cells = (title: string) => {
      // empty cells are not written: place each cell by its column letter
      const row = [...x.sheet.matchAll(/<row [^>]*>(.*?)<\/row>/g)].map((m) => {
        const out: string[] = Array(12).fill('');
        for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*>(.*?)<\/c>/g)) out[c[1].charCodeAt(0) - 65] = c[2].replace(/<[^>]+>/g, '');
        return out;
      });
      return { head: row[0], row: row.find((r) => r.includes(title))! };
    };
    const { head, row } = cells('Полная');
    assert.deepEqual(head, ['Приоритет', 'Задача', 'Категория', 'Сотрудник', 'Изначальный срок', 'Новый срок', 'Дата выполнения', 'Оценка в часах', 'Факт в часах', 'Комментарий', 'Сделано', 'Влетевшая']);
    assert.deepEqual(row, ['2', 'Полная', cat.name, 'Азат Резяпов', '19.10.2026', '23.10.2026', '22.10.2026', '5', '6', 'Комментарий к задаче', 'Да', 'Да']);
    const empty = cells('Пустая').row;
    assert.deepEqual(empty, ['', 'Пустая', empty[2], '', '', '', '', '', '', '', 'Нет', 'Нет']);
  });

  test('API key with exports:read can download XLSX but never write to Google', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const k = (await app.call('POST', '/api/me/api-keys', { name: 'export', scopes: ['exports:read'] }, pm)).body.token;
    const h = { authorization: `Bearer ${k}` };
    assert.equal((await app.call('POST', '/api/exports/preview', { query: '' }, null, h)).status, 200);
    assert.equal((await app.call('POST', '/api/exports/google', { query: '', confirm_external: true }, null, h)).status, 403);
    const k2 = (await app.call('POST', '/api/me/api-keys', { name: 'read', scopes: ['tasks:read'] }, pm)).body.token;
    assert.equal((await app.call('POST', '/api/exports/preview', { query: '' }, null, { authorization: `Bearer ${k2}` })).status, 403, 'no exports scope');
  });
});

void xlsxOf;

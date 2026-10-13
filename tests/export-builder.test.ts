// vNext PR 9 (ТЗ §3 «Экспорт ссылок», §4; owner decision 13.10 №15): the export builder — field catalog by rights,
// columns / titles / order, filters, sort, two groupings with subtotals and Excel outline levels, several links of
// one type in one cell, personal and shared templates, the built-in TaskFlow template unchanged, Google to its own tab.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TASKFLOW_SPEC as TASKFLOW } from '../worker/domain/exportFields';
import { setup, type TestApp } from './helpers';

function unzip(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  while (p + 30 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extra = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(buf.subarray(p + 30, p + 30 + nameLen));
    out[name] = new TextDecoder().decode(buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size));
    p += 30 + nameLen + extra + size;
  }
  return out;
}
const bytes = async (app: TestApp, path: string, body: unknown, cookie: string) => new Uint8Array(await (await app.raw('POST', path, body, cookie)).arrayBuffer());
async function calendar(app: TestApp, cookie: string) {
  const pv = (await app.call('POST', '/api/calendar/generate-preview', {}, cookie)).body;
  await app.call('POST', '/api/calendar/generate', { plan_hash: pv.plan_hash }, cookie);
}
const v = (app: TestApp, id: string) => app.one('SELECT version FROM features WHERE id = ?', id).version;

describe('export builder', () => {
  test('the built-in TaskFlow template gives exactly the old exchange file', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const legacy = await bytes(app, '/api/exports/xlsx', { query: 'hide_closed=1' }, pm);
    const builtin = await bytes(app, '/api/exports/build/xlsx', { template_id: 'builtin:taskflow', spec: undefined }, pm);
    const all = await bytes(app, '/api/exports/xlsx', { query: '' }, pm);
    assert.deepEqual(Buffer.from(builtin), Buffer.from(all), 'same bytes as the legacy export of the same selection');
    assert.notDeepEqual(Buffer.from(legacy), Buffer.from(all));
    // the builder page always sends the spec: an untouched TaskFlow layout with other filters is still the exchange file
    const withFilters = await bytes(app, '/api/exports/build/xlsx', { template_id: 'builtin:taskflow', spec: { ...TASKFLOW, query: 'hide_closed=1' } }, pm);
    assert.deepEqual(Buffer.from(withFilters), Buffer.from(legacy));
    const pv = (await app.call('POST', '/api/exports/build/preview', { template_id: 'builtin:taskflow' }, pm)).body;
    assert.match(pv.structure.google, /«Import»/);
    assert.deepEqual(pv.header, ['Приоритет', 'Задача', 'Категория', 'Сотрудник', 'Изначальный срок', 'Новый срок', 'Дата выполнения', 'Оценка в часах', 'Факт в часах', 'Комментарий', 'Сделано', 'Влетевшая']);
    const tpl = (await app.call('GET', '/api/exports/templates', undefined, pm)).body.templates;
    assert.equal(tpl[0].id, 'builtin:taskflow');
    assert.equal((await app.call('PUT', '/api/exports/templates/builtin:taskflow', { name: 'x', version: 1 }, pm)).status, 403, 'built-in is read-only');
  });

  test('the catalog follows the rights: a field the viewer may not see is not offered and not exported', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const ids = (g: any) => g.groups.flatMap((x: any) => x.fields.map((f: any) => f.id));
    const forPm = ids((await app.call('GET', '/api/exports/fields', undefined, pm)).body);
    const forLead = ids((await app.call('GET', '/api/exports/fields', undefined, lead)).body);
    for (const f of ['key', 'title', 'status', 'assignee', 'sprint', 'release', 'priority_score', 'estimate_total', 'links', 'links:jira', 'proposals', 'baseline_production_date']) assert.ok(forLead.includes(f), f);
    for (const f of ['visibility', 'internal']) { assert.ok(forPm.includes(f)); assert.ok(!forLead.includes(f), `${f} not for a lead`); }
    assert.ok(!forPm.some((f: string) => /private|notes/.test(f)), 'private notes are never exportable');
    const hidden = (await app.call('POST', '/api/features', { title: 'Скрытая проработка', is_product_internal: true }, pm)).body;
    const spec = { columns: [{ field: 'key' }, { field: 'title' }, { field: 'visibility' }], query: 'internal=all', sort: [], groups: [], subtotals: true };
    const p = (await app.call('POST', '/api/exports/build/preview', { spec }, lead)).body;
    assert.deepEqual(p.skipped, ['visibility']);
    assert.deepEqual(p.header, ['ID', 'Название']);
    assert.ok(!JSON.stringify(p).includes(hidden.key));
    assert.equal((await app.call('POST', '/api/exports/build/preview', { spec: { ...spec, columns: [{ field: 'visibility' }] } }, lead)).status, 400);
  });

  test('two groupings with subtotals and outline levels; titles, order, sort; several links of one type in one cell', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const be = app.one("SELECT id FROM resource_teams WHERE code = 'backend'").id;
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const mk = async (title: string, assignee: string, h: number) => {
      const t = (await app.call('POST', '/api/features', { title, assignee_name: assignee, estimates: { [be]: h }, tags: ['отчёт-тест'] }, pm)).body;
      await app.call('PATCH', `/api/features/${t.id}/schedule`, { sprint_id: s81.id, version: v(app, t.id) }, pm);
      return t;
    };
    const a = await mk('Альфа', 'Анна', 10);
    await mk('Бета', 'Анна', 5);
    await mk('Гамма', 'Борис', 3);
    await app.call('POST', `/api/features/${a.id}/links`, { url: 'https://jira.example.com/browse/R-1' }, pm);
    await app.call('POST', `/api/features/${a.id}/links`, { url: 'https://jira.example.com/browse/R-2' }, pm);
    const spec = {
      columns: [{ field: 'title', title: 'Задача' }, { field: 'estimate_total', title: 'Часы' }, { field: 'links:jira' }],
      query: 'tag=отчёт-тест', sort: [{ field: 'title', dir: 'desc' }], groups: ['sprint', 'assignee'], subtotals: true,
    };
    const p = (await app.call('POST', '/api/exports/build/preview', { spec }, pm)).body;
    assert.equal(p.count, 3);
    assert.deepEqual(p.header, ['Задача', 'Часы', 'Ссылки: Jira']);
    const shape = p.rows.map((r: any) => `${r.kind}${r.level}:${r.cells[0]}|${r.cells[1] ?? ''}`);
    assert.deepEqual(shape, [
      'group0:Спринт: 8.1 · 3|18',
      'group1:Ответственный: Анна · 2|15',
      'task2:Бета|5',
      'task2:Альфа|10',
      'group1:Ответственный: Борис · 1|3',
      'task2:Гамма|3',
    ]);
    assert.equal(p.rows.find((r: any) => r.cells[0] === 'Альфа').cells[2], 'https://jira.example.com/browse/R-1\nhttps://jira.example.com/browse/R-2');
    assert.match(p.structure.excel, /сворачивать/);
    const numericOnly = (await app.call('POST', '/api/exports/build/preview', { spec: { ...spec, columns: [{ field: 'estimate_total' }] } }, pm)).body;
    assert.equal(numericOnly.header[0], 'Группа');
    assert.equal(numericOnly.rows[0].cells[0], 'Спринт: 8.1 · 3');
    assert.equal(numericOnly.rows[0].cells[1], 18);

    const files = unzip(await bytes(app, '/api/exports/build/xlsx', { spec }, pm));
    const sheet = files['xl/worksheets/sheet1.xml'];
    assert.ok(sheet.includes('<outlinePr summaryBelow="0"/>'));
    assert.ok(sheet.includes('outlineLevelRow="2"'));
    assert.equal(sheet.match(/outlineLevel="2"/g)?.length, 3, 'tasks on level 2');
    assert.equal(sheet.match(/outlineLevel="1"/g)?.length, 2, 'second-level groups on level 1');
    assert.ok(sheet.includes('R-1\nhttps://jira.example.com/browse/R-2'), 'links in one cell, one per line');
    assert.ok(!sheet.includes('<f>'));
    assert.ok(files['xl/styles.xml'].includes('wrapText="1"'));
  });

  test('templates: personal for the owner only, shared by an administrator for everyone', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const spec = { columns: [{ field: 'key' }, { field: 'title' }], query: '', sort: [], groups: [], subtotals: true };
    const mine = await app.call('POST', '/api/exports/templates', { name: 'Мой отчёт', spec }, pm);
    assert.equal(mine.status, 201);
    assert.equal((await app.call('POST', '/api/exports/templates', { name: 'Общий', scope: 'shared', spec }, pm)).status, 403);
    const shared = (await app.call('POST', '/api/exports/templates', { name: 'Отчёт для всех', scope: 'shared', spec }, admin)).body;
    const leadList = (await app.call('GET', '/api/exports/templates', undefined, lead)).body.templates;
    assert.ok(leadList.some((t: any) => t.id === shared.id && !t.can_edit));
    assert.ok(!leadList.some((t: any) => t.id === mine.body.id), 'personal templates are private');
    assert.equal((await app.call('POST', '/api/exports/build/preview', { template_id: mine.body.id }, lead)).status, 404);
    assert.equal((await app.call('PUT', `/api/exports/templates/${shared.id}`, { name: 'Взлом', version: 1 }, lead)).status, 403);
    assert.equal((await app.call('PUT', `/api/exports/templates/${mine.body.id}`, { name: 'Мой отчёт 2', spec: { ...spec, groups: ['status'] }, version: 1 }, pm)).status, 200);
    assert.equal((await app.call('PUT', `/api/exports/templates/${mine.body.id}`, { name: 'Старое', version: 1 }, pm)).status, 409, 'optimistic lock');
    const pv = (await app.call('POST', '/api/exports/build/preview', { template_id: mine.body.id }, pm)).body;
    assert.equal(pv.rows[0].kind, 'group');
    assert.equal(pv.structure.sheet, 'Мой отчёт 2');
    assert.equal((await app.call('DELETE', `/api/exports/templates/${mine.body.id}`, undefined, pm)).status, 200);
  });

  test('Google: a custom template writes its own tab (created if missing), never the TaskFlow «Import» tab', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const pm = await app.user('pm@test.io', 'product');
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
    app.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n` });
    const calls: { url: string; body?: any }[] = [];
    app.env.__FETCH = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'w', expires_in: 3600 }), { status: 200 });
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.includes(':batchUpdate')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 0, title: 'Данные' } }, { properties: { sheetId: 77, title: 'Import' } }] }), { status: 200 });
    }) as typeof fetch;
    await app.call('PUT', '/api/admin/settings', { export_google_spreadsheet_id: '1ExportTargetSpreadsheetId0000000000000' }, admin);
    const spec = { columns: [{ field: 'key' }, { field: 'title' }], query: 'hide_closed=1', sort: [], groups: ['status'], subtotals: true };
    const t = (await app.call('POST', '/api/exports/templates', { name: 'Статусы', spec }, pm)).body;
    const ask = await app.call('POST', '/api/exports/build/google', { template_id: t.id }, pm);
    assert.equal(ask.body.error.code, 'confirm_external');
    assert.match(ask.body.error.message, /Экспорт — Статусы/);
    const ok = await app.call('POST', '/api/exports/build/google', { template_id: t.id, confirm_external: true }, pm);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const reqs = calls.find((c) => c.url.includes(':batchUpdate'))!.body.requests;
    const add = reqs.find((x: any) => x.addSheet);
    assert.equal(add.addSheet.properties.title, `Экспорт — Статусы · ${t.id}`);
    const sameName = (await app.call('POST', '/api/exports/templates', { name: 'Статусы', spec }, pm)).body;
    const secondPreview = (await app.call('POST', '/api/exports/build/preview', { template_id: sameName.id }, pm)).body;
    assert.ok(secondPreview.structure.google.includes(sameName.id));
    assert.ok(!secondPreview.structure.google.includes(t.id), 'same-name templates have separate tabs');
    assert.ok(!JSON.stringify(reqs).includes('"sheetId":77') && !JSON.stringify(reqs).includes('"sheetId":0,'), 'the Import tab and other tabs are not touched');
    const rows = reqs.find((x: any) => x.updateCells?.rows).updateCells.rows;
    assert.deepEqual(rows[0].values.map((x: any) => x.userEnteredValue?.stringValue), ['Статус', 'ID', 'Название'], 'flat: the grouping field comes first');
  });
});

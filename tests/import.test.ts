import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEMO_SHEETS } from '../worker/demoData';
import { setup, type TestApp } from './helpers';

async function demoSource(app: TestApp, cookie: string) {
  const s = await app.call('POST', '/api/import/sources', { name: 'Демо-таблица', kind: 'csv', demo: true }, cookie);
  assert.equal(s.status, 201);
  return s.body.id as string;
}

async function preview(app: TestApp, cookie: string, sourceId: string) {
  const r = await app.call('POST', `/api/import/sources/${sourceId}/preview`, {}, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.run;
}

const item = (run: any, ext: string) => run.items.find((i: any) => i.external_id === ext);

async function resolve(app: TestApp, cookie: string, run: any, ext: string, resolution: unknown) {
  const it = item(run, ext);
  const r = await app.call('PATCH', `/api/import/runs/${run.id}/items/${it.id}`, { resolution }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

/** First import of the demo spreadsheet with all decisions made. */
async function firstImport(app: TestApp, pm: string) {
  const src = await demoSource(app, pm);
  const run = await preview(app, pm, src);
  await resolve(app, pm, run, 'GS-EP-11', { mode: 'link', targetId: 'ep_5' });
  await resolve(app, pm, run, 'GS-106', { mode: 'link', targetId: 'feat_001' });
  await resolve(app, pm, run, 'RAF-530', { mode: 'update', fields: { description: 'local' }, protected: {} });
  const applied = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  return { src, run, applied: applied.body };
}

async function uploadCsv(app: TestApp, cookie: string, src: string, sheets: Record<string, string>) {
  const s = (await app.call('GET', '/api/import/sources', undefined, cookie)).body.sources.find((x: any) => x.id === src);
  const r = await app.call('PUT', `/api/import/sources/${src}/csv`, { sheets, version: s.version }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

const countAll = (app: TestApp) => ({
  features: app.one('SELECT COUNT(*) AS n FROM features').n,
  epics: app.one('SELECT COUNT(*) AS n FROM epics').n,
  relations: app.one('SELECT COUNT(*) AS n FROM feature_relations').n,
  estimates: app.one('SELECT COUNT(*) AS n FROM feature_estimates').n,
});

describe('import: preview and decisions', () => {
  test('preview groups rows and writes nothing to the catalog', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const before = countAll(app);
    const run = await preview(app, pm, await demoSource(app, pm));
    assert.deepEqual(countAll(app), before, 'preview must not change catalog entities');
    assert.equal(item(run, 'GS-EP-10').action, 'create');
    assert.equal(item(run, 'GS-EP-11').action, 'duplicate');
    assert.equal(item(run, 'GS-106').action, 'duplicate', 'similar task is never merged automatically');
    assert.equal(item(run, 'GS-106').candidates[0].id, 'feat_001');
    assert.equal(item(run, 'RAF-530').action, 'update', 'matched by business identifier');
    assert.equal(item(run, 'RAF-530').diff[0].kind, 'conflict');
    assert.equal(run.unresolved.length, 3);
    const blocked = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm);
    assert.equal(blocked.status, 400);
    assert.deepEqual(countAll(app), before);
  });

  test('apply creates drafts, links sources, keeps chosen local values', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const before = countAll(app);
    const { applied } = await firstImport(app, pm);
    const after = countAll(app);
    assert.equal(after.features - before.features, 6); // GS-106 linked to RF-1
    assert.equal(after.epics - before.epics, 1); // GS-EP-11 linked to EP-5
    assert.equal(applied.counts.linked, 2);
    const created = app.many(`SELECT * FROM features WHERE external_ref LIKE 'GS-%' ORDER BY number`);
    assert.ok(created.every((f: any) => f.visibility === 'draft'), 'imported cards start as drafts');
    assert.deepEqual(created.map((f: any) => f.number), [27, 28, 29, 30, 31, 32]);
    // imported estimates are marked as not manually refined
    assert.ok(app.many(`SELECT is_manual FROM feature_estimates WHERE feature_id = ?`, created[0].id).every((e: any) => e.is_manual === 0));
    // relations: blocks, belongs_to_epic via the linked epic
    const gs105 = created.find((f: any) => f.external_ref === 'GS-105');
    assert.equal(gs105.epic_id, 'ep_5');
    // conflict resolved as "keep local"
    assert.equal(app.one(`SELECT description FROM features WHERE id = 'feat_018'`).description, 'Страница доступности трекинга, кабинета и API с историей инцидентов.');
    // linked existing card was not overwritten
    assert.equal(app.one(`SELECT description FROM features WHERE id = 'feat_001'`).description.startsWith('Передача статусов'), true);
    // drafts are invisible to guests
    assert.ok(!(await app.call('GET', '/api/features')).body.features.some((f: any) => f.title.includes('Push-уведомления')));
    // journal
    const runs = (await app.call('GET', '/api/import/runs', undefined, pm)).body.runs;
    assert.equal(runs[0].status, 'applied');
    assert.equal(runs[0].created_by, 'pm');
    assert.equal(runs[0].counts.created, 7); // 1 epic + 6 tasks
    assert.equal(runs[0].counts.conflicts[0].choice, 'local');
  });

  test('re-import of the same spreadsheet creates no duplicates; double apply is rejected', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const { src, run } = await firstImport(app, pm);
    const snapshot = countAll(app);
    // repeated apply of the same run
    const again = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_applied');
    // a brand new sync of unchanged data
    const run2 = await preview(app, pm, src);
    const actions = new Set(run2.items.map((i: any) => i.action));
    assert.deepEqual([...actions].sort(), ['unchanged']);
    assert.equal((await app.call('POST', `/api/import/runs/${run2.id}/apply`, {}, pm)).status, 200);
    assert.deepEqual(countAll(app), snapshot);
    // reordered rows do not matter
    const lines = DEMO_SHEETS.features.split('\r\n');
    await uploadCsv(app, pm, src, { features: [lines[0], ...lines.slice(1).reverse()].join('\r\n') });
    const run3 = await preview(app, pm, src);
    assert.ok(run3.items.every((i: any) => i.action === 'unchanged'));
  });

  test('a removed row never deletes the card; source edits update, local edits conflict, protected fields stay', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const { src } = await firstImport(app, pm);
    const f101 = app.one(`SELECT * FROM features WHERE external_ref = 'GS-101'`);
    const f104 = app.one(`SELECT * FROM features WHERE external_ref = 'GS-104'`);
    // local edit of GS-104 title and a manual refinement of GS-101 backend hours
    assert.equal((await app.call('PATCH', `/api/features/${f104.id}`, { title: 'Конструктор отчётов (уточнено)', version: f104.version }, pm)).status, 200);
    assert.equal((await app.call('PUT', `/api/features/${f101.id}/estimates`, { estimates: { team_backend: 55 }, versions: { team_backend: 1 } }, pm)).status, 200);
    // product team set the status locally
    const v101 = app.one('SELECT version FROM features WHERE id = ?', f101.id).version;
    assert.equal((await app.call('PATCH', `/api/features/${f101.id}`, { status_id: 'st_f_ready', version: v101 }, pm)).status, 200);

    const lines = DEMO_SHEETS.features.split('\r\n');
    const edited = lines
      .filter((l) => !l.startsWith('GS-103,'))
      .map((l) => (l.startsWith('GS-102,') ? l.replace('Экран статистики в мобильном приложении', 'Экран статистики (мобильный)') : l))
      .map((l) => (l.startsWith('GS-104,') ? l.replace('Конструктор отчётов для рекламодателя', 'Конструктор отчётов 2.0') : l))
      .map((l) => (l.startsWith('GS-101,') ? l.replace(',Новая,Product,2026-09-28,40,', ',В работе,Product,2026-09-28,60,') : l));
    await uploadCsv(app, pm, src, { features: edited.join('\r\n') });
    const run = await preview(app, pm, src);
    const i102 = item(run, 'GS-102');
    assert.equal(i102.action, 'update');
    assert.equal(i102.diff[0].kind, 'update');
    const i104 = item(run, 'GS-104');
    assert.equal(i104.diff.find((d: any) => d.field === 'title').kind, 'conflict');
    const i101 = item(run, 'GS-101');
    const kinds = Object.fromEntries(i101.diff.map((d: any) => [d.field, d.kind]));
    assert.equal(kinds.status_id, 'protected');
    assert.equal(kinds['hours:team_backend'], 'protected', 'manually refined hours are protected');
    assert.equal(item(run, 'GS-103'), undefined);
    // keep local title for GS-104; explicitly confirm only the hours of GS-101 (status stays local)
    await resolve(app, pm, run, 'GS-104', { mode: 'update', fields: { title: 'local' }, protected: {} });
    await resolve(app, pm, run, 'GS-101', { mode: 'update', fields: {}, protected: { 'hours:team_backend': true } });
    assert.equal((await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm)).status, 200);
    assert.equal(app.one(`SELECT title FROM features WHERE external_ref = 'GS-102'`).title, 'Экран статистики (мобильный)');
    assert.equal(app.one(`SELECT title FROM features WHERE external_ref = 'GS-104'`).title, 'Конструктор отчётов (уточнено)');
    assert.ok(app.one(`SELECT id FROM features WHERE external_ref = 'GS-103'`), 'card is not deleted when its row disappears');
    assert.equal(app.one(`SELECT status_id FROM features WHERE id = ?`, f101.id).status_id, 'st_f_ready', 'unconfirmed protected field is kept');
    assert.equal(app.one(`SELECT hours FROM feature_estimates WHERE feature_id = ? AND team_id = 'team_backend'`, f101.id).hours, 60, 'confirmed protected field is applied');
    // a declined protected change is not offered again until the sheet changes it once more
    const run2 = await preview(app, pm, src);
    assert.equal(item(run2, 'GS-101').action, 'unchanged');
  });

  test('votes, approved releases and plans are never touched by a sync', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    const { src } = await firstImport(app, pm);
    const f = app.one(`SELECT * FROM features WHERE external_ref = 'GS-105'`);
    await app.call('PUT', `/api/features/${f.id}/votes/dep_product`, { score: 5, expected_version: null }, pm);
    await app.call('PATCH', `/api/features/${f.id}/placement`, { period_id: 'per_2026_12', lock: true, version: f.version }, pm);
    const rel = app.one(`SELECT version FROM releases WHERE id = 'rel_2'`);
    await app.call('PUT', '/api/releases/rel_2/features', { feature_ids: ['feat_002', 'feat_007', 'feat_006', f.id], version: rel.version }, pm);
    const before = {
      votes: app.many(`SELECT * FROM department_votes WHERE feature_id = ?`, f.id),
      placement: app.one(`SELECT period_id, placement_locked FROM features WHERE id = ?`, f.id),
      releases: app.many(`SELECT * FROM release_features ORDER BY feature_id`),
      approved: app.many(`SELECT id, approved_at FROM releases ORDER BY id`),
    };
    const lines = DEMO_SHEETS.features.split('\r\n').map((l) => (l.startsWith('GS-105,') ? l.replace('Ежедневная сводка', 'Ежедневная сводка (обновлено)') : l));
    await uploadCsv(app, pm, src, { features: lines.join('\r\n') });
    const run = await preview(app, pm, src);
    assert.equal((await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm)).status, 200);
    assert.deepEqual(app.many(`SELECT * FROM department_votes WHERE feature_id = ?`, f.id), before.votes);
    assert.deepEqual(app.one(`SELECT period_id, placement_locked FROM features WHERE id = ?`, f.id), before.placement);
    assert.deepEqual(app.many(`SELECT * FROM release_features ORDER BY feature_id`), before.releases);
    assert.deepEqual(app.many(`SELECT id, approved_at FROM releases ORDER BY id`), before.approved);
    assert.match(app.one(`SELECT title FROM features WHERE id = ?`, f.id).title, /обновлено/);
  });
});

describe('import: safety', () => {
  test('stale preview cannot be applied after the source changed', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await demoSource(app, pm);
    const run = await preview(app, pm, src);
    await uploadCsv(app, pm, src, { epics: DEMO_SHEETS.epics.replace('Мобильное приложение вебмастера', 'Мобильное приложение') });
    const before = countAll(app);
    await resolve(app, pm, run, 'GS-EP-11', { mode: 'link', targetId: 'ep_5' });
    await resolve(app, pm, run, 'GS-106', { mode: 'skip' });
    await resolve(app, pm, run, 'RAF-530', { mode: 'update', fields: { description: 'local' } });
    const r = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'stale');
    assert.deepEqual(countAll(app), before);
    assert.equal(app.one('SELECT status FROM import_runs WHERE id = ?', run.id).status, 'stale');
  });

  test('cards edited after the preview make the whole apply fail with nothing written', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await demoSource(app, pm);
    const run = await preview(app, pm, src);
    await resolve(app, pm, run, 'GS-EP-11', { mode: 'skip' });
    await resolve(app, pm, run, 'GS-106', { mode: 'skip' });
    await resolve(app, pm, run, 'RAF-530', { mode: 'update', fields: { description: 'source' }, protected: {} });
    // a feature that points to a skipped epic must be decided first
    const unresolved = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm);
    assert.equal(unresolved.status, 400);
    assert.match(JSON.stringify(unresolved.body), /GS-EP-11/);
    await resolve(app, pm, run, 'GS-EP-11', { mode: 'link', targetId: 'ep_5' });
    // someone edits the matched card between preview and apply
    const o = app.one(`SELECT version FROM features WHERE id = 'feat_018'`);
    assert.equal((await app.call('PATCH', '/api/features/feat_018', { assignee_name: 'Кто-то другой', version: o.version }, pm)).status, 200);
    const before = countAll(app);
    const r = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(countAll(app), before, 'no epics, features or relations from this run were written');
    assert.equal(app.one('SELECT status FROM import_runs WHERE id = ?', run.id).status, 'preview');
  });

  test('a failure in the middle of the write leaves no partial data', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await demoSource(app, pm);
    const run = await preview(app, pm, src);
    await resolve(app, pm, run, 'GS-EP-11', { mode: 'create' });
    await resolve(app, pm, run, 'GS-106', { mode: 'create' });
    await resolve(app, pm, run, 'RAF-530', { mode: 'skip' });
    const before = countAll(app);
    // inject a failing statement into the middle of the transaction
    const realBatch = app.db.batch.bind(app.db);
    app.db.batch = (async (stmts: any[]) => {
      if (stmts.length > 20) {
        const mid = Math.floor(stmts.length / 2);
        stmts = [...stmts.slice(0, mid), app.db.prepare('INSERT INTO no_such_table VALUES (1)'), ...stmts.slice(mid)];
      }
      return realBatch(stmts);
    }) as typeof app.db.batch;
    const r = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm);
    app.db.batch = realBatch;
    assert.equal(r.status, 500);
    assert.deepEqual(countAll(app), before);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM source_entity_links').n, 0);
    assert.equal(app.one('SELECT status FROM import_runs WHERE id = ?', run.id).status, 'failed');
  });

  test('untrusted cells: validation errors point to sheet and row; HTML / formulas are stored as plain text', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = (await app.call('POST', '/api/import/sources', { name: 'CSV', kind: 'csv' }, pm)).body.id;
    await uploadCsv(app, pm, src, {
      features: [
        'external_id,title,description,status,backend_hours,qa_hours,unknown_column',
        'X-1,<img src=x onerror=alert(1)>,"=HYPERLINK(""http://evil"",""click"")",Неизвестный,10,abc,zzz',
        'X-2,,нет названия,,,,',
        'X-3,Нормальная задача,<script>alert(1)</script>,Новая,5,2,',
        'X-3,Повтор,повтор,,,,',
      ].join('\n'),
    });
    const run = await preview(app, pm, src);
    const x1 = item(run, 'X-1');
    assert.equal(x1.action, 'error');
    assert.match(x1.errors.join(), /qa_hours/);
    assert.equal(x1.row_number, 2);
    assert.equal(x1.sheet, 'Features');
    assert.ok(x1.warnings.some((w: string) => w.includes('Неизвестный')));
    assert.match(run.items.find((i: any) => i.row_number === 3).errors.join(), /title/);
    assert.match(run.items.find((i: any) => i.row_number === 5).errors.join(), /Повтор external_id/);
    assert.equal((await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm)).status, 200);
    const x3 = app.one(`SELECT description FROM features WHERE external_ref = 'X-3'`);
    assert.equal(x3.description, '<script>alert(1)</script>', 'kept verbatim as text (rendered escaped by the UI)');
    assert.equal(app.one(`SELECT COUNT(*) AS n FROM features WHERE external_ref = 'X-1'`).n, 0);
  });

  test('Google Sheets unavailable → clear error, backlog untouched', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = (await app.call('POST', '/api/import/sources', { name: 'Google', kind: 'google', spreadsheet: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0' }, pm)).body.id;
    app.env.__FETCH = (async () => { throw new Error('network down'); }) as typeof fetch;
    const before = countAll(app);
    const r = await app.call('POST', `/api/import/sources/${src}/preview`, {}, pm);
    assert.equal(r.status, 502);
    assert.match(r.body.error.message, /не изменены/);
    assert.deepEqual(countAll(app), before);
    const chk = await app.call('POST', `/api/import/sources/${src}/check`, {}, pm);
    assert.equal(chk.body.ok, false);
  });

  test('Google Sheets via read-only service account (JWT signed in the worker)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    app.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'roadmap-reader@project.iam.gserviceaccount.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' });
    const seen: string[] = [];
    const toRows = (csv: string) => csv.split('\r\n').map((l) => l.split(','));
    app.env.__FETCH = (async (url: string, init?: RequestInit) => {
      seen.push(String(url));
      if (String(url).includes('oauth2')) {
        const body = String(init?.body);
        const jwt = decodeURIComponent(body.split('assertion=')[1]);
        const [h, p, sig] = jwt.split('.');
        const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${h}.${p}`));
        const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
        assert.ok(ok, 'JWT signature must verify');
        assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
        return new Response(JSON.stringify({ access_token: 'tkn', expires_in: 3600 }), { status: 200 });
      }
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer tkn');
      if (String(url).includes('values:batchGet')) {
        return new Response(JSON.stringify({ valueRanges: [{ values: toRows(DEMO_SHEETS.epics) }, { values: [['external_id', 'title'], ['G-1', 'Задача из Google']] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ properties: { title: 'Rafinad backlog' }, sheets: [{ properties: { title: 'Epics' } }, { properties: { title: 'Features' } }] }), { status: 200 });
    }) as typeof fetch;
    const src = (await app.call('POST', '/api/import/sources', { name: 'Google', kind: 'google', spreadsheet: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' }, pm)).body.id;
    const chk = await app.call('POST', `/api/import/sources/${src}/check`, {}, pm);
    assert.equal(chk.body.ok, true, JSON.stringify(chk.body));
    assert.match(chk.body.message, /Rafinad backlog/);
    const list = (await app.call('GET', '/api/import/sources', undefined, pm)).body;
    assert.equal(list.service_account_email, 'roadmap-reader@project.iam.gserviceaccount.com');
    assert.ok(!JSON.stringify(list).includes('PRIVATE KEY'), 'secret never returned by the API');
    const run = await preview(app, pm, src);
    assert.equal(item(run, 'G-1').action, 'create');
    assert.ok(seen.some((u) => u.includes('sheets.googleapis.com')));
  });
});

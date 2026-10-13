// vNext PR 8 (ТЗ §5; owner decision 13.10 №14): permanent deletion by an administrator — preview of consequences,
// confirmation by the key, one transaction, no dangling rows, history wiped with one audit record of the fact,
// numbers never reused, imported records do not come back by themselves (tombstone + conscious restore).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup, type TestApp } from './helpers';

const FEATURE_TABLES = ['feature_tags', 'feature_estimates', 'department_votes', 'release_features', 'comments', 'feature_blockers', 'feature_links',
  'proposal_features', 'feature_plan_baselines', 'feature_phase_events', 'feature_phase_forecasts'];

async function calendar(app: TestApp, cookie: string) {
  const pv = (await app.call('POST', '/api/calendar/generate-preview', {}, cookie)).body;
  await app.call('POST', '/api/calendar/generate', { plan_hash: pv.plan_hash }, cookie);
}
const v = (app: TestApp, id: string) => app.one('SELECT version FROM features WHERE id = ?', id).version;

describe('permanent deletion', () => {
  test('only an administrator, after a preview and the exact key; everything around the task goes, nothing dangles', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    await calendar(app, pm);
    const be = app.one("SELECT id FROM resource_teams WHERE code = 'backend'").id;
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const a = (await app.call('POST', '/api/features', { title: 'Ошибочная задача', estimates: { [be]: 10 }, tags: ['тест'] }, pm)).body;
    const b = (await app.call('POST', '/api/features', { title: 'Соседняя задача' }, pm)).body;
    const dup = (await app.call('POST', '/api/features', { title: 'Дубль ошибочной' }, pm)).body;
    await app.call('POST', `/api/features/${a.id}/comments`, { body: 'Комментарий' }, pm);
    await app.call('PUT', `/api/features/${a.id}/votes/dep_sales`, { score: 4, expected_version: null }, lead);
    await app.call('POST', `/api/features/${a.id}/relations`, { type: 'blocks', target_id: b.id }, pm);
    await app.call('POST', `/api/features/${a.id}/blockers`, { expectation: 'Решение', owner_department_id: 'dep_finance' }, pm);
    await app.call('POST', `/api/features/${a.id}/links`, { url: 'https://jira.example.com/browse/X-1' }, pm);
    await app.call('PATCH', `/api/features/${a.id}/schedule`, { sprint_id: s81.id, release_id: s81.release_id, version: v(app, a.id) }, pm);
    const prop = (await app.call('POST', '/api/proposals', { title: 'Запрос бизнеса' }, lead)).body;
    await app.call('POST', `/api/proposals/${prop.id}/features`, { feature_id: a.key }, pm);
    const mp = (await app.call('GET', `/api/features/${dup.key}/merge-preview?target_id=${a.key}`, undefined, pm)).body;
    assert.equal((await app.call('POST', `/api/features/${dup.key}/merge`, { target_id: a.key, source_version: mp.source.version, target_version: mp.target.version, confirm: true }, pm)).status, 200);

    // nobody but the administrator
    assert.equal((await app.call('GET', `/api/admin/purge/feature/${a.key}`, undefined, pm)).status, 403);
    assert.equal((await app.call('POST', `/api/admin/purge/feature/${a.key}`, { confirm: a.key, version: 1 }, pm)).status, 403);

    const pv = (await app.call('GET', `/api/admin/purge/feature/${a.key}`, undefined, admin)).body;
    assert.equal(pv.confirm, a.key);
    assert.deepEqual(pv.merged, [dup.key]);
    const labels = pv.effects.map((e: any) => e.label);
    for (const l of ['Объединённые дубли', 'Комментарии', 'Оценки часов', 'Голоса отделов', 'Теги', 'Связи с задачами', 'Блокировки (ожидания)', 'Внешние ссылки', 'Релиз', 'Спринт', 'Предложения', 'История изменений', 'Аналитика']) {
      assert.ok(labels.includes(l), `preview shows «${l}»`);
    }
    assert.ok(pv.effects.find((e: any) => e.label === 'Связи с задачами').items.some((x: string) => x.includes(b.key)));

    assert.equal((await app.call('POST', `/api/admin/purge/feature/${a.key}`, { confirm: 'RF-0', version: pv.version }, admin)).status, 400, 'wrong key');
    assert.equal((await app.call('POST', `/api/admin/purge/feature/${a.key}`, { confirm: a.key, version: pv.version + 7 }, admin)).status, 409, 'stale preview');
    const r = await app.call('POST', `/api/admin/purge/feature/${a.key}`, { confirm: a.key.toLowerCase(), version: pv.version, reason: 'Тестовая запись' }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.deleted, [a.key, dup.key]);

    const ids = [a.id, dup.id];
    for (const t of FEATURE_TABLES) assert.equal(app.one(`SELECT COUNT(*) AS n FROM ${t} WHERE feature_id IN (?, ?)`, ...ids).n, 0, t);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM feature_relations WHERE from_id IN (?, ?) OR to_id IN (?, ?)', ...ids, ...ids).n, 0);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM features WHERE id IN (?, ?)', ...ids).n, 0);
    assert.ok(app.one('SELECT id FROM features WHERE id = ?', b.id), 'related task stays');
    assert.ok(app.one('SELECT id FROM proposals WHERE id = ?', prop.id), 'proposal stays');
    assert.equal(app.one("SELECT COUNT(*) AS n FROM proposal_features WHERE proposal_id = ?", prop.id).n, 0);
    // history wiped; one record of the fact, without content
    const logs = app.many("SELECT * FROM audit_log WHERE entity_type = 'feature' AND entity_id IN (?, ?)", ...ids);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'deleted_permanently');
    assert.equal(logs[0].reason, 'Тестовая запись');
    assert.match(logs[0].changes, new RegExp(a.key));
    assert.ok(!logs[0].changes.includes('Комментарий'));
    // the card is gone for everyone, the number is not reused
    assert.equal((await app.call('GET', `/api/features/${a.key}`, undefined, admin)).status, 404);
    const next = (await app.call('POST', '/api/features', { title: 'Новая' }, pm)).body;
    assert.ok(Number(next.key.slice(3)) > Number(dup.key.slice(3)), `${next.key} after ${dup.key}`);
    assert.equal((await app.call('GET', `/api/features/${b.key}`, undefined, pm)).status, 200);
  });

  test('epics and proposals: tasks stay (without the epic / the link), duplicates go along, numbers are not reused', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const ep = (await app.call('POST', '/api/epics', { title: 'Тестовый эпик' }, pm)).body;
    const t = (await app.call('POST', '/api/features', { title: 'Задача эпика', epic_id: ep.id }, pm)).body;
    const epv = (await app.call('GET', `/api/admin/purge/epic/${ep.id}`, undefined, admin)).body;
    assert.ok(epv.effects.find((e: any) => e.label === 'Задачи эпика').items[0].includes(t.key));
    assert.equal((await app.call('POST', `/api/admin/purge/epic/${ep.id}`, { confirm: epv.key, version: epv.version }, admin)).status, 200);
    assert.equal(app.one('SELECT epic_id FROM features WHERE id = ?', t.id).epic_id, null);
    assert.ok(app.many("SELECT * FROM audit_log WHERE entity_type = 'feature' AND entity_id = ? AND changes LIKE '%epic%'", t.id).length >= 1, 'the task history tells where its epic went');

    const p1 = (await app.call('POST', '/api/proposals', { title: 'Предложение' }, lead)).body;
    const p2 = (await app.call('POST', '/api/proposals', { title: 'Его дубль' }, lead)).body;
    await app.call('POST', `/api/proposals/${p1.id}/features`, { feature_id: t.key }, pm);
    const pv1 = (n: string) => app.one('SELECT version FROM proposals WHERE id = ?', n).version;
    assert.equal((await app.call('POST', `/api/proposals/${p2.id}/merge`, { target_id: p1.id, source_version: pv1(p2.id), target_version: pv1(p1.id), confirm: true }, pm)).status, 200);
    const ppv = (await app.call('GET', `/api/admin/purge/proposal/${p1.key}`, undefined, admin)).body;
    assert.deepEqual(ppv.merged, [p2.key]);
    assert.equal((await app.call('POST', `/api/admin/purge/proposal/${p1.key}`, { confirm: p1.key, version: ppv.version }, admin)).status, 200);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM proposals WHERE id IN (?, ?)', p1.id, p2.id).n, 0);
    assert.ok(app.one('SELECT id FROM features WHERE id = ?', t.id), 'the task stays');
    const p3 = (await app.call('POST', '/api/proposals', { title: 'Новое' }, lead)).body;
    assert.ok(Number(p3.key.slice(2)) > Number(p2.key.slice(2)));
    assert.equal((await app.call('GET', `/api/admin/purge/thing/${p1.key}`, undefined, admin)).status, 400);
  });

  test('an imported task deleted for good is not re-created by the next sync; «Восстановить импорт» brings it back consciously', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const pm = await app.user('pm@test.io', 'product');
    const src = (await app.call('POST', '/api/import/sources', { name: 'CSV', kind: 'csv' }, pm)).body.id;
    const s = (await app.call('GET', '/api/import/sources', undefined, pm)).body.sources.find((x: any) => x.id === src);
    await app.call('PUT', `/api/import/sources/${src}/csv`, { sheets: { features: 'external_id,title\nT-1,Задача из таблицы\nT-2,Вторая задача' }, version: s.version }, pm);
    const preview = async () => (await app.call('POST', `/api/import/sources/${src}/preview`, {}, pm)).body.run;
    const apply = async (run: any) => app.call('POST', `/api/import/runs/${run.id}/apply`, {}, pm);
    assert.equal((await apply(await preview())).status, 200);
    const f = app.one("SELECT * FROM features WHERE external_ref = 'T-1'");

    const pv = (await app.call('GET', `/api/admin/purge/feature/${f.id}`, undefined, admin)).body;
    assert.ok(pv.effects.find((e: any) => e.label === 'Импорт из таблиц').items[0].includes('T-1'));
    assert.equal((await app.call('POST', `/api/admin/purge/feature/${f.id}`, { confirm: pv.key, version: pv.version }, admin)).status, 200);
    assert.equal(app.one("SELECT COUNT(*) AS n FROM source_entity_links WHERE entity_id = ?", f.id).n, 0);
    assert.equal(app.one("SELECT COUNT(*) AS n FROM import_items WHERE target_id = ?", f.id).n, 0, 'copies in old previews are wiped');
    const tomb = app.one("SELECT * FROM import_tombstones WHERE source_id = ? AND external_id = 'T-1'", src);
    assert.equal(tomb.entity_key, pv.key);

    let run = await preview();
    let it = run.items.find((i: any) => i.external_id === 'T-1');
    assert.equal(it.action, 'create');
    assert.deepEqual(it.resolution, { mode: 'skip' });
    assert.match(it.warnings.join(), /удалена администратором/);
    assert.equal(run.items.find((i: any) => i.external_id === 'T-2').action, 'unchanged', 'other rows unaffected');
    assert.equal((await apply(run)).status, 200);
    assert.equal(app.one("SELECT COUNT(*) AS n FROM features WHERE external_ref = 'T-1'").n, 0, 'not re-created');

    run = await preview();
    it = run.items.find((i: any) => i.external_id === 'T-1');
    assert.equal((await app.call('PATCH', `/api/import/runs/${run.id}/items/${it.id}`, { resolution: { mode: 'create' } }, pm)).status, 200);
    assert.equal((await apply(run)).status, 200);
    const back = app.one("SELECT * FROM features WHERE external_ref = 'T-1'");
    assert.ok(back && back.id !== f.id && back.number > f.number, 'restored as a new card with a new number');
    assert.equal(app.one("SELECT COUNT(*) AS n FROM import_tombstones WHERE source_id = ?", src).n, 0);
    assert.equal((await preview()).items.find((i: any) => i.external_id === 'T-1').action, 'unchanged');
  });
});

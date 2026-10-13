// vNext PR 2 (ТЗ §1.2, §8 «Предложения»): any employee proposes; departments vote only for themselves;
// product decides with reasons; many-to-many with tasks; auto «Запланировано»; merge keeps authors and history.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canTransition, TRANSITIONS } from '../worker/domain/proposals';
import { setup, type TestApp } from './helpers';

async function propose(app: TestApp, cookie: string | null, body: Record<string, unknown> = { title: 'Выгрузка выплат в 1С' }) {
  return app.call('POST', '/api/proposals', body, cookie);
}
const get = async (app: TestApp, cookie: string, ref: string) => (await app.call('GET', `/api/proposals/${ref}`, undefined, cookie)).body.proposal;
async function status(app: TestApp, cookie: string, ref: string, to: string, reason?: string) {
  const p = await get(app, cookie, ref);
  return app.call('POST', `/api/proposals/${ref}/status`, { status: to, version: p.version, ...(reason ? { reason } : {}) }, cookie);
}

describe('proposals: status model', () => {
  test('transitions follow the agreed flow', () => {
    assert.ok(canTransition('new', 'review'));
    assert.ok(canTransition('review', 'rejected'));
    assert.ok(canTransition('rejected', 'review'), 'rejected can be returned for review');
    assert.ok(canTransition('postponed', 'review'), 'postponed can be returned for review');
    assert.ok(canTransition('accepted', 'planned'), 'manual «planned» when no development is needed');
    assert.ok(!canTransition('new', 'implemented'));
    assert.ok(!canTransition('rejected', 'planned'));
    assert.deepEqual(TRANSITIONS.planned, ['implemented', 'accepted']);
  });
});

describe('proposals API', () => {
  test('any signed-in employee creates a proposal; a guest cannot; everyone signed in sees all proposals', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales'], 'Ольга Продажи');
    const fin = await app.user('fin@test.io', 'department_lead', ['dep_finance']);
    assert.equal((await propose(app, null)).status, 401);
    assert.equal((await app.call('GET', '/api/proposals')).status, 401);
    const c = await propose(app, lead, { title: 'Отчёт по возвратам', description: 'Нужно видеть возвраты по партнёрам', expected_result: 'Меньше ручных сверок', department_id: 'dep_sales' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.key, 'P-1');
    const seen = (await app.call('GET', '/api/proposals', undefined, fin)).body.proposals;
    assert.equal(seen.length, 1, 'all proposals are visible to all employees');
    assert.equal(seen[0].author.name, 'Ольга Продажи');
    assert.equal(seen[0].department.id, 'dep_sales');
    assert.equal(seen[0].status.name, 'Новое');
    // the author edits while it is being decided; somebody else cannot
    const p = await get(app, lead, 'P-1');
    assert.equal((await app.call('PATCH', '/api/proposals/P-1', { title: 'Отчёт по возвратам и отменам', version: p.version }, lead)).status, 200);
    assert.equal((await app.call('PATCH', '/api/proposals/P-1', { title: 'Чужая правка', version: p.version + 1 }, fin)).status, 403);
    // comments from anybody signed in
    assert.equal((await app.call('POST', '/api/proposals/P-1/comments', { body: 'Нам тоже нужно' }, fin)).status, 201);
    assert.equal((await get(app, fin, 'P-1')).comments.length, 1);
  });

  test('votes: only for an own department, one vote per department; admin override needs a reason', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const admin = await app.user('admin@test.io', 'admin');
    await propose(app, lead);
    assert.equal((await app.call('PUT', '/api/proposals/P-1/votes/dep_sales', { score: 5, expected_version: null }, lead)).status, 200);
    assert.equal((await app.call('PUT', '/api/proposals/P-1/votes/dep_finance', { score: 5, expected_version: null }, lead)).status, 403, 'no voting for another department');
    const dup = await app.call('PUT', '/api/proposals/P-1/votes/dep_sales', { score: 4, expected_version: null }, lead);
    assert.equal(dup.status, 409, 'a second vote of the same department is a conflict, not a duplicate');
    assert.equal((await app.call('PUT', '/api/proposals/P-1/votes/dep_sales', { score: 4, expected_version: 1 }, lead)).status, 200);
    assert.equal((await app.call('PUT', '/api/proposals/P-1/votes/dep_finance', { score: 2, expected_version: null }, admin)).status, 400, 'reason required');
    assert.equal((await app.call('PUT', '/api/proposals/P-1/votes/dep_finance', { score: 2, expected_version: null, reason: 'По письму финдиректора' }, admin)).status, 200);
    const p = await get(app, lead, 'P-1');
    assert.equal(p.priority.voters, 2);
    assert.equal(app.one("SELECT COUNT(*) AS n FROM proposal_votes WHERE proposal_id = ?", p.id).n, 2);
    assert.ok(app.one("SELECT is_override FROM audit_log WHERE entity_type = 'proposal' AND action = 'vote_admin_override'").is_override);
    // proposal votes never touch task votes
    assert.equal(app.one("SELECT COUNT(*) AS n FROM department_votes WHERE voted_by IN (SELECT id FROM users WHERE email = 'lead@test.io')").n, 0);
  });

  test('product decides: reason required to postpone / reject, history kept, back to review possible; others cannot decide', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const pm = await app.user('pm@test.io', 'product');
    await propose(app, lead);
    assert.equal((await status(app, lead, 'P-1', 'review')).status, 403);
    assert.equal((await status(app, pm, 'P-1', 'review')).status, 200);
    assert.equal((await status(app, pm, 'P-1', 'rejected')).status, 400, 'reason required');
    assert.equal((await status(app, pm, 'P-1', 'rejected', 'Дублирует отчёт в BI')).status, 200);
    let p = await get(app, lead, 'P-1');
    assert.equal(p.status.code, 'rejected');
    assert.equal(p.decision_reason, 'Дублирует отчёт в BI', 'the author sees the reason');
    assert.equal((await status(app, pm, 'P-1', 'implemented')).status, 400, 'no jump from rejected to implemented');
    assert.equal((await status(app, pm, 'P-1', 'review')).status, 200);
    assert.equal((await status(app, pm, 'P-1', 'postponed', 'Вернёмся в следующем квартале')).status, 200);
    p = await get(app, lead, 'P-1');
    const statuses = p.history.filter((h: any) => h.action === 'status').map((h: any) => `${h.changes[0].old}→${h.changes[0].new}${h.reason ? `:${h.reason}` : ''}`);
    assert.deepEqual(statuses.reverse(), ['new→review', 'review→rejected:Дублирует отчёт в BI', 'rejected→review', 'review→postponed:Вернёмся в следующем квартале']);
    // the author cannot edit the text after the decision
    assert.equal((await app.call('PATCH', '/api/proposals/P-1', { title: 'x', version: p.version }, lead)).status, 403);
  });

  test('many-to-many with tasks; a task in a sprint moves an accepted proposal to «Запланировано»; «Реализовано» only by decision', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const pv = (await app.call('POST', '/api/calendar/generate-preview', {}, pm)).body;
    await app.call('POST', '/api/calendar/generate', { plan_hash: pv.plan_hash }, pm);
    const s81 = app.one("SELECT id FROM sprints WHERE code = '8.1'").id;
    await propose(app, lead, { title: 'А' });
    await propose(app, lead, { title: 'Б' });
    const t1 = (await app.call('POST', '/api/features', { title: 'Задача 1' }, pm)).body;
    const t2 = (await app.call('POST', '/api/features', { title: 'Задача 2' }, pm)).body;
    assert.equal((await app.call('POST', '/api/proposals/P-1/features', { feature_id: t1.key }, lead)).status, 403, 'linking is a product action');
    for (const [p, t] of [['P-1', t1.id], ['P-1', t2.id], ['P-2', t1.id]]) assert.equal((await app.call('POST', `/api/proposals/${p}/features`, { feature_id: t }, pm)).status, 201);
    assert.equal((await get(app, lead, 'P-1')).tasks.length, 2, 'one proposal → several tasks');
    const card = (await app.call('GET', `/api/features/${t1.id}`, undefined, lead)).body.feature;
    assert.deepEqual(card.proposals.map((p: any) => p.key), ['P-1', 'P-2'], 'one task → several proposals');
    await status(app, pm, 'P-1', 'accepted');
    // sprint assignment of a linked task → planned automatically
    assert.equal((await app.call('PATCH', `/api/features/${t1.id}/schedule`, { sprint_id: s81, version: 1 }, pm)).status, 200);
    let p1 = await get(app, lead, 'P-1');
    assert.equal(p1.status.code, 'planned');
    assert.ok(p1.history.some((h: any) => h.action === 'status_auto'));
    assert.ok(p1.delivery.forecast.production_date, 'business sees the forecast');
    assert.equal((await get(app, lead, 'P-2')).status.code, 'new', 'only accepted proposals move automatically');
    // links survive status changes
    await status(app, pm, 'P-1', 'accepted');
    assert.equal((await get(app, lead, 'P-1')).tasks.length, 2);
    // a past release date never marks it implemented; all tasks done → only a hint
    const done = app.one("SELECT id FROM statuses WHERE entity = 'feature' AND semantic = 'done' LIMIT 1").id;
    for (const t of [t1.id, t2.id]) {
      const v = app.one('SELECT version FROM features WHERE id = ?', t).version;
      await app.call('PATCH', `/api/features/${t}`, { status_id: done, version: v }, pm);
    }
    p1 = await get(app, pm, 'P-1');
    assert.equal(p1.status.code, 'accepted');
    assert.equal(p1.delivery.all_done, true);
    await status(app, pm, 'P-1', 'planned');
    assert.equal((await status(app, pm, 'P-1', 'implemented')).status, 200);
    assert.equal((await get(app, lead, 'P-1')).implemented_at?.length, 10);
  });

  test('a hidden Product task linked to a proposal never shows up for business: not in tasks, counters, forecast or history', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    await propose(app, lead);
    const hidden = (await app.call('POST', '/api/features', { title: 'Секретная проработка', is_product_internal: true, planned_end: '2026-12-01' }, pm)).body;
    assert.equal((await app.call('POST', '/api/proposals/P-1/features', { feature_id: hidden.id }, pm)).status, 201);
    const forLead = await app.call('GET', '/api/proposals/P-1', undefined, lead);
    const txt = JSON.stringify(forLead.body);
    assert.ok(!txt.includes(hidden.id) && !txt.includes('Секретная') && !txt.includes(hidden.key));
    assert.equal(forLead.body.proposal.delivery.total, 0);
    assert.equal(forLead.body.proposal.delivery.forecast.production_date, null);
    assert.ok(!JSON.stringify((await app.call('GET', '/api/proposals', undefined, lead)).body).includes('2026-12-01'));
    const forPm = (await get(app, pm, 'P-1')).tasks;
    assert.equal(forPm.length, 1);
    assert.equal(forPm[0].is_product_internal, true);
  });

  test('merging duplicates keeps both authors and history; votes, tasks and comments move without double votes', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const sales = await app.user('sales@test.io', 'department_lead', ['dep_sales'], 'Ольга');
    const fin = await app.user('fin@test.io', 'department_lead', ['dep_finance'], 'Пётр');
    await propose(app, sales, { title: 'Отчёт по возвратам' });
    await propose(app, fin, { title: 'Возвраты в отчёте' });
    await app.call('PUT', '/api/proposals/P-1/votes/dep_sales', { score: 3, expected_version: null }, sales);
    await app.call('PUT', '/api/proposals/P-2/votes/dep_finance', { score: 5, expected_version: null }, fin);
    await app.call('POST', '/api/proposals/P-2/comments', { body: 'Срочно' }, fin);
    const t = (await app.call('POST', '/api/features', { title: 'Отчёт' }, pm)).body;
    await app.call('POST', '/api/proposals/P-2/features', { feature_id: t.id }, pm);
    const [a, b] = [await get(app, pm, 'P-1'), await get(app, pm, 'P-2')];
    assert.equal((await app.call('POST', '/api/proposals/P-2/merge', { target_id: 'P-1', source_version: b.version, target_version: a.version, confirm: true }, sales)).status, 403);
    const m = await app.call('POST', '/api/proposals/P-2/merge', { target_id: 'P-1', source_version: b.version, target_version: a.version, confirm: true }, pm);
    assert.equal(m.status, 200, JSON.stringify(m.body));
    const main = await get(app, pm, 'P-1');
    assert.equal(main.priority.voters, 2);
    assert.deepEqual(main.tasks.map((x: any) => x.id), [t.id]);
    assert.equal(main.comments[0].moved_from, 'P-2');
    assert.deepEqual(main.merged_from.map((x: any) => `${x.key} ${x.author_name}`), ['P-2 Пётр'], 'the duplicate and its author are kept');
    const dupe = await get(app, fin, 'P-2');
    assert.equal(dupe.merged_into_ref.key, 'P-1');
    assert.equal(dupe.author.name, 'Пётр');
    assert.ok(!(await app.call('GET', '/api/proposals', undefined, pm)).body.proposals.some((x: any) => x.key === 'P-2'), 'merged ones are hidden from the list by default');
    assert.equal((await app.call('PUT', '/api/proposals/P-2/votes/dep_finance', { score: 1, expected_version: null }, fin)).status, 409);
  });

  test('list: search, filters by status / department / author / date, sort by popularity; API keys may read and create', async () => {
    const app = await setup();
    const sales = await app.user('sales@test.io', 'department_lead', ['dep_sales']);
    const pm = await app.user('pm@test.io', 'product');
    await propose(app, sales, { title: 'Первое', department_id: 'dep_sales' });
    await propose(app, sales, { title: 'Второе про выплаты' });
    await app.call('PUT', '/api/proposals/P-2/votes/dep_sales', { score: 5, expected_version: null }, sales);
    const list = async (q: string) => (await app.call('GET', `/api/proposals?${q}`, undefined, pm)).body.proposals.map((x: any) => x.key);
    assert.deepEqual(await list(''), ['P-2', 'P-1'], 'popular first');
    assert.deepEqual(await list('sort=newest'), ['P-2', 'P-1']);
    assert.deepEqual(await list('q=выплат'), ['P-2']);
    assert.deepEqual(await list('department=dep_sales'), ['P-1']);
    assert.deepEqual(await list('status=new'), ['P-2', 'P-1']);
    assert.deepEqual(await list('status=accepted'), []);
    assert.deepEqual(await list('from=2000-01-01&to=2000-12-31'), []);
    const key = (await app.call('POST', '/api/me/api-keys', { name: 'k', scopes: ['tasks:read', 'tasks:create'] }, sales)).body.token;
    const h = { authorization: `Bearer ${key}` };
    assert.equal((await app.call('GET', '/api/proposals', undefined, null, h)).status, 200);
    assert.equal((await app.call('POST', '/api/proposals', { title: 'Через ключ' }, null, h)).status, 201);
    assert.equal((await app.call('PUT', '/api/proposals/P-1/votes/dep_sales', { score: 1, expected_version: null }, null, h)).status, 403, 'votes are not for keys');
  });
});

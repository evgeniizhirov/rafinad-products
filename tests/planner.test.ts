// vNext PR 7 (ТЗ §2, §6): the Product planner — queue by priority, next sprints with team hours vs capacity, monthly
// budget, hidden Product tasks; only for the product team; sprints only (no old planning periods).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup, type TestApp } from './helpers';

async function calendar(app: TestApp, cookie: string) {
  const pv = (await app.call('POST', '/api/calendar/generate-preview', {}, cookie)).body;
  await app.call('POST', '/api/calendar/generate', { plan_hash: pv.plan_hash }, cookie);
}
const v = (app: TestApp, id: string) => app.one('SELECT version FROM features WHERE id = ?', id).version;

describe('Product planner', () => {
  test('only the product team opens it; business and guests do not', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    assert.equal((await app.call('GET', '/api/planner', undefined, pm)).status, 200);
    assert.equal((await app.call('GET', '/api/planner', undefined, lead)).status, 403);
    assert.ok([401, 403].includes((await app.call('GET', '/api/planner')).status));
  });

  test('queue by priority → sprint: hours per team against capacity, budget months, hidden tasks apart', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const be = app.one("SELECT id FROM resource_teams WHERE code = 'backend'").id;
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    await app.call('PUT', '/api/planning/sprint-capacity', { sprint_id: s81.id, team_id: be, hours: 12 }, pm);
    const a = (await app.call('POST', '/api/features', { title: 'Очередь А', estimates: { [be]: 8 } }, pm)).body;
    const hidden = (await app.call('POST', '/api/features', { title: 'Скрытая проработка', is_product_internal: true, planned_end: '2026-11-01' }, pm)).body;
    const bug = (await app.call('POST', '/api/features', { title: 'Баг в спринте', task_kind: 'bug' }, pm)).body;

    let p = (await app.call('GET', '/api/planner', undefined, pm)).body;
    const ranks = p.queue.map((t: any) => t.rank);
    assert.deepEqual(ranks, [...ranks].sort((x: number, y: number) => x - y), 'queue goes by priority');
    const qa = p.queue.find((t: any) => t.id === a.id);
    assert.equal(qa.hours, 8);
    assert.equal(qa.estimates[be], 8);
    assert.ok(!p.queue.some((t: any) => t.id === hidden.id || t.id === bug.id), 'only planned business tasks queue for sprints');
    assert.ok(p.internal.some((t: any) => t.id === hidden.id && t.is_product_internal && t.planned_end === '2026-11-01'));
    assert.equal(p.sprints[0].code, '8.1');
    assert.ok(p.budget.some((m: any) => m.month === '2026-10'));

    // the move uses the ordinary schedule API, with all its rules
    assert.equal((await app.call('PATCH', `/api/features/${a.id}/schedule`, { sprint_id: s81.id, release_id: s81.release_id, version: v(app, a.id) }, pm)).status, 200);
    await app.call('PATCH', `/api/features/${bug.id}/schedule`, { sprint_id: s81.id, version: v(app, bug.id) }, pm);
    p = (await app.call('GET', '/api/planner', undefined, pm)).body;
    const sp = p.sprints.find((s: any) => s.code === '8.1');
    assert.ok(!p.queue.some((t: any) => t.id === a.id));
    assert.ok(sp.tasks.some((t: any) => t.id === a.id));
    assert.equal(sp.load[be], 8);
    assert.equal(sp.capacity[be], 12);
    assert.deepEqual(sp.over_capacity, []);
    assert.ok(sp.reference.some((t: any) => t.id === bug.id), 'a bug in a sprint is a reference only');
    assert.ok(!sp.tasks.some((t: any) => t.id === bug.id));
    assert.equal(sp.release.name, 'Релиз 8');
  });

  test('a task still open in a closed sprint comes back to the queue as a carry-over', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const a = (await app.call('POST', '/api/features', { title: 'Не успели' }, pm)).body;
    await app.call('PATCH', `/api/features/${a.id}/schedule`, { sprint_id: s81.id, version: v(app, a.id) }, pm);
    app.many("UPDATE sprints SET status = 'closed' WHERE id = ? RETURNING 1", s81.id);
    const p = (await app.call('GET', '/api/planner', undefined, pm)).body;
    assert.ok(p.queue.some((t: any) => t.id === a.id && t.carry_from === '8.1'));
    assert.ok(!p.sprints.some((s: any) => s.code === '8.1'), 'closed sprints are not offered');
  });
});

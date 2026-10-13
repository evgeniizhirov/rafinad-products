// vNext PR 6 (ТЗ §2, §8 «Общий Гант»): one shared diagram for business and Product, per-task phases from the sprint,
// current release + two next as the default horizon, nothing hidden leaks, nothing invented.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup, type TestApp } from './helpers';

async function calendar(app: TestApp, cookie: string) {
  const pv = (await app.call('POST', '/api/calendar/generate-preview', {}, cookie)).body;
  await app.call('POST', '/api/calendar/generate', { plan_hash: pv.plan_hash }, cookie);
}
const v = (app: TestApp, id: string) => app.one('SELECT version FROM features WHERE id = ?', id).version;
const allTasks = (g: any) => [...g.releases.flatMap((r: any) => r.sprints.flatMap((s: any) => s.groups.flatMap((x: any) => x.tasks))), ...g.outside];

describe('shared Gantt', () => {
  test('business and Product get the very same diagram; hidden and draft tasks leak nowhere (rows, counters, tooltips)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    await calendar(app, pm);
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const pub = (await app.call('POST', '/api/features', { title: 'Видимая задача', visibility: 'internal', assignee_name: 'Анна' }, pm)).body;
    const hidden = (await app.call('POST', '/api/features', { title: 'Скрытая проработка', is_product_internal: true, planned_start: '2026-10-08', planned_end: '2026-10-10' }, pm)).body;
    const draft = (await app.call('POST', '/api/features', { title: 'Черновик задачи', visibility: 'draft' }, pm)).body;
    for (const t of [pub, draft]) await app.call('PATCH', `/api/features/${t.id}/schedule`, { sprint_id: s81.id, version: v(app, t.id) }, pm);
    const forPm = (await app.call('GET', '/api/gantt', undefined, pm)).body;
    const forLead = (await app.call('GET', '/api/gantt', undefined, lead)).body;
    assert.deepEqual(forPm, forLead, 'identical for business and Product');
    const txt = JSON.stringify(forPm);
    for (const secret of [hidden.id, hidden.key, 'Скрытая проработка', draft.id, 'Черновик задачи']) assert.ok(!txt.includes(secret), `no ${secret}`);
    assert.ok(allTasks(forPm).some((t: any) => t.id === pub.id));
    // readiness counts only what is shown
    const r8 = forPm.releases.find((r: any) => r.cycle === 8);
    assert.equal(r8.readiness, 0);
    // hidden tasks are in the Product planner, marked
    assert.equal((await app.call('GET', '/api/gantt?scope=planner', undefined, lead)).status, 403);
    const planner = (await app.call('GET', '/api/gantt?scope=planner', undefined, pm)).body;
    assert.ok(allTasks(planner).some((t: any) => t.id === hidden.id && t.is_product_internal));
  });

  test('tree release → sprint → kind group; every planned task has its own phases from its sprint; horizon = current + 2', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const s82 = app.one("SELECT * FROM sprints WHERE code = '8.2'");
    const a = (await app.call('POST', '/api/features', { title: 'План А' }, pm)).body;
    const b = (await app.call('POST', '/api/features', { title: 'План Б' }, pm)).body;
    const bug = (await app.call('POST', '/api/features', { title: 'Баг', task_kind: 'bug' }, pm)).body;
    await app.call('PATCH', `/api/features/${a.id}/schedule`, { sprint_id: s81.id, version: v(app, a.id) }, pm);
    await app.call('PATCH', `/api/features/${b.id}/schedule`, { sprint_id: s82.id, version: v(app, b.id) }, pm);
    await app.call('PATCH', `/api/features/${bug.id}/schedule`, { sprint_id: s81.id, version: v(app, bug.id) }, pm);
    const g = (await app.call('GET', '/api/gantt', undefined, pm)).body;
    const r8 = g.releases.find((r: any) => r.cycle === 8);
    const sp = (code: string) => r8.sprints.find((s: any) => s.code === code);
    assert.deepEqual(sp('8.1').groups.map((x: any) => x.label), ['Релизные задачи', 'Баги']);
    const ta = sp('8.1').groups[0].tasks.find((t: any) => t.id === a.id);
    const tb = sp('8.2').groups[0].tasks.find((t: any) => t.id === b.id);
    const dev = (t: any) => t.timeline.phases.find((p: any) => p.phase === 'dev').plan;
    assert.deepEqual(dev(ta), { start: s81.start_date, end: s81.end_date });
    assert.deepEqual(dev(tb), { start: s82.start_date, end: s82.end_date }, 'each task gets its own segments from its own sprint');
    assert.equal(ta.timeline.release.plan, s81.production_due);
    assert.equal(ta.timeline.agreed, false);
    assert.equal(sp('8.1').groups[1].tasks[0].timeline.agreed, false, 'bugs only appear in the plan');
    assert.equal(g.window.releases.length, 3, 'current release + two next');
    assert.equal(g.window.releases[0], r8.id);
    assert.ok(g.range.from <= g.window.from && g.range.to >= g.window.to, 'later plans are not cut off');
  });

  test('a task without a sprint is drawn only with reliable own dates; otherwise it is counted, not invented', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const dated = (await app.call('POST', '/api/features', { title: 'С датами', task_kind: 'bug', planned_end: '2026-10-30' }, pm)).body;
    const before = (await app.call('GET', '/api/gantt', undefined, pm)).body.undated;
    await app.call('POST', '/api/features', { title: 'Без дат' }, pm);
    const g = (await app.call('GET', '/api/gantt', undefined, pm)).body;
    assert.ok(g.outside.some((t: any) => t.id === dated.id && t.timeline.release.plan === '2026-10-30'));
    assert.ok(!g.outside.some((t: any) => t.title === 'Без дат'));
    assert.equal(g.undated, before + 1);
    assert.equal(JSON.stringify(g).includes('estimate'), false, 'no estimates on a Gantt');
  });

  test('guests see only public tasks and public releases', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const internal = (await app.call('POST', '/api/features', { title: 'Для сотрудников', visibility: 'internal' }, pm)).body;
    await app.call('PATCH', `/api/features/${internal.id}/schedule`, { sprint_id: s81.id, version: v(app, internal.id) }, pm);
    const g = (await app.call('GET', '/api/gantt')).body;
    assert.ok(!JSON.stringify(g).includes(internal.id));
    assert.ok(allTasks(g).every((t: any) => t.assignee === undefined), 'no assignees for guests');
  });
});

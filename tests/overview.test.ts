// P06 / FR-03: overview = KPI, Gantt, release focus, business blockers, upcoming releases.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup, type TestApp } from './helpers';

const status = (app: TestApp, sem: string) => app.one("SELECT id FROM statuses WHERE entity = 'feature' AND semantic = ? ORDER BY sort_order LIMIT 1", sem).id;

async function mk(app: TestApp, cookie: string, body: Record<string, unknown>) {
  const r = await app.call('POST', '/api/features', body, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { id: string; key: string };
}

describe('overview: Gantt', () => {
  test('only active work with an end date; bugs included; hidden Product tasks and planned-only work excluded (T11, T12)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const inWork = status(app, 'in_progress');
    const a = await mk(app, pm, { title: 'Гант: в работе со сроком', status_id: inWork, planned_start: '2026-10-05', planned_end: '2026-10-20' });
    const b = await mk(app, pm, { title: 'Гант: без срока', status_id: inWork });
    const c = await mk(app, pm, { title: 'Гант: запланирована', status_id: status(app, 'planned'), planned_end: '2026-10-20' });
    const bug = await mk(app, pm, { title: 'Гант: баг в работе', task_kind: 'bug', status_id: inWork, planned_end: '2026-10-15' });
    const bugNoDate = await mk(app, pm, { title: 'Гант: баг без срока', task_kind: 'bug', status_id: inWork });
    const hidden = await mk(app, pm, { title: 'Гант: скрытая', is_product_internal: true, status_id: inWork, planned_end: '2026-10-20' });
    const analysis = await mk(app, pm, { title: 'Гант: проработка без старта', status_id: status(app, 'analysis'), planned_end: '2026-10-30' });
    for (const cookie of [pm, lead]) {
      const g = (await app.call('GET', '/api/overview', undefined, cookie)).body.gantt;
      const ids = g.map((x: any) => x.feature.id);
      assert.ok(ids.includes(a.id) && ids.includes(bug.id) && ids.includes(analysis.id));
      for (const x of [b, c, bugNoDate, hidden]) assert.ok(!ids.includes(x.id), `${x.key} must not be on the Gantt`);
      const item = g.find((x: any) => x.feature.id === analysis.id);
      assert.equal(item.start, null, 'start is never invented');
      assert.equal(item.end, '2026-10-30');
      assert.equal(g.find((x: any) => x.feature.id === bug.id).feature.task_kind, 'bug');
    }
  });
});

describe('overview: focus and blockers', () => {
  test('focus tasks of the nearest release are listed even when not started; epic goal counts both sprints once', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const pv = (await app.call('POST', '/api/calendar/generate-preview', {}, pm)).body;
    await app.call('POST', '/api/calendar/generate', { plan_hash: pv.plan_hash }, pm);
    const s1 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const s2 = app.one("SELECT * FROM sprints WHERE code = '8.2'");
    const epic = app.one('SELECT id FROM epics ORDER BY number LIMIT 1').id;
    const goal = await mk(app, pm, { title: 'Цель релиза 8', is_focus: true, epic_id: epic });
    const part2 = await mk(app, pm, { title: 'Часть цели во втором спринте', epic_id: epic, status_id: status(app, 'done') });
    await app.call('PATCH', `/api/features/${goal.id}/schedule`, { sprint_id: s1.id, version: 1 }, pm);
    await app.call('PATCH', `/api/features/${part2.id}/schedule`, { sprint_id: s2.id, version: 1 }, pm);
    const focus = (await app.call('GET', '/api/overview', undefined, pm)).body.focus;
    assert.equal(focus.release.id, s1.release_id);
    assert.deepEqual(focus.release.sprints.map((s: any) => [s.code, s.production_due]), [['8.1', '2026-10-29'], ['8.2', '2026-11-12']]);
    const item = focus.items.find((x: any) => x.feature.id === goal.id);
    assert.ok(item, 'focus task listed although it is not in work');
    assert.equal(item.planned_production_date, '2026-10-29');
    assert.deepEqual([item.epic.total, item.epic.done], [2, 1]);
  });

  test('business blocker: what, from whom, since when; counted as blocked; resolve; leads cannot create; guests see no details', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const f = await mk(app, pm, { title: 'Ждём решение', visibility: 'public', status_id: status(app, 'in_progress') });
    const before = (await app.call('GET', '/api/overview', undefined, pm)).body.kpi.blocked;
    assert.equal((await app.call('POST', `/api/features/${f.id}/blockers`, { expectation: 'x', owner_name: 'y' }, lead)).status, 403);
    assert.equal((await app.call('POST', `/api/features/${f.id}/blockers`, { expectation: 'Согласование тарифа' }, pm)).status, 400, 'owner required');
    const r = await app.call('POST', `/api/features/${f.id}/blockers`, { expectation: 'Согласование тарифа', owner_department_id: 'dep_finance', started_at: '2026-10-01', due_at: '2026-10-05' }, pm);
    assert.equal(r.status, 201);
    const ov = (await app.call('GET', '/api/overview', undefined, lead)).body;
    assert.equal(ov.kpi.blocked, before + 1);
    const bl = ov.business_blockers.find((x: any) => x.feature.id === f.id);
    assert.equal(bl.kind, 'business');
    assert.equal(bl.waiting_for, 'Согласование тарифа');
    assert.equal(bl.owner, 'Финансы');
    assert.equal(bl.since, '2026-10-01');
    assert.ok(bl.days >= 0);
    assert.ok(bl.unblocks.includes(f.key));
    assert.ok((await app.call('GET', '/api/features?flag=blocked', undefined, pm)).body.features.some((x: any) => x.id === f.id));
    const guest = (await app.call('GET', '/api/overview', undefined, null)).body.business_blockers.find((x: any) => x.feature.id === f.id);
    assert.equal(guest.waiting_for, null);
    assert.equal(guest.blocker, undefined);
    // resolve with history
    const v = app.one('SELECT version FROM feature_blockers WHERE id = ?', r.body.id).version;
    assert.equal((await app.call('PATCH', `/api/blockers/${r.body.id}`, { resolved: true, resolution: 'Согласовано', version: v }, pm)).status, 200);
    assert.ok(!(await app.call('GET', '/api/overview', undefined, pm)).body.business_blockers.some((x: any) => x.feature.id === f.id));
    assert.ok(app.one("SELECT 1 AS ok FROM audit_log WHERE entity_id = ? AND action = 'blocker_resolved'", f.id));
  });

  test('blockers of hidden Product tasks never appear for other departments', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const f = await mk(app, pm, { title: 'Скрытая заблокированная', is_product_internal: true });
    await app.call('POST', `/api/features/${f.id}/blockers`, { expectation: 'Секретное ожидание', owner_name: 'Кто-то' }, pm);
    const body = JSON.stringify((await app.call('GET', '/api/overview', undefined, lead)).body);
    assert.ok(!body.includes('Секретное ожидание') && !body.includes(f.id));
  });
});

// P04 / FR-05: monthly budget, rates by sprint, month × sprint allocation, team availability per sprint.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { monthlyForecast, rateOn, splitByMonth } from '../worker/domain/budget';
import { setup, type TestApp } from './helpers';

describe('budget arithmetic', () => {
  test('sprint 8.2 (21.10–03.11) is split by working days between October and November (T09)', () => {
    const s = splitByMonth('2026-10-21', '2026-11-03', 'workdays');
    // October: 21,22,23,26,27,28,29,30 = 8 working days; November: 2,3 = 2
    assert.equal(s.get('2026-10'), 0.8);
    assert.equal(s.get('2026-11'), 0.2);
    const c = splitByMonth('2026-10-21', '2026-11-03', 'calendar_days');
    assert.equal(c.get('2026-10'), 11 / 14);
    assert.equal(splitByMonth('2026-10-24', '2026-10-25').get('2026-10'), 1, 'weekend-only interval falls back to calendar days');
  });

  test('rates: the version in force at the sprint start; Product/Design cost nothing but keep hours (T08, T10)', () => {
    const rates = [
      { team_id: 'be', effective_from: '2000-01-01', rate_rub_per_hour: 2200, include_in_budget: 1 },
      { team_id: 'be', effective_from: '2026-11-04', rate_rub_per_hour: 3000, include_in_budget: 1 },
      { team_id: 'pr', effective_from: '2000-01-01', rate_rub_per_hour: 0, include_in_budget: 0 },
    ];
    assert.equal(rateOn(rates, 'be', '2026-10-21')?.rate, 2200);
    assert.equal(rateOn(rates, 'be', '2026-11-04')?.rate, 3000);
    const teams = [{ id: 'be', active: true }, { id: 'pr', active: true }];
    const r = monthlyForecast([{ id: 'f', key: 'RF-1', title: 't', from: '2026-10-07', to: '2026-10-20', rateDate: '2026-10-07', estimates: { be: 10, pr: 40 } }], rates, teams, 'workdays');
    assert.equal(r.get('2026-10')!.cost, 22000);
    assert.equal(r.get('2026-10')!.hours.pr, 40, 'Product hours stay in availability');
    const missing = monthlyForecast([{ id: 'g', key: 'RF-2', title: 't', from: '2026-10-07', to: '2026-10-20', rateDate: '2026-10-07', estimates: { pr: 8 } }], rates, teams, 'workdays');
    assert.equal(missing.get('2026-10')!.incomplete, 1, 'paid team without an estimate = incomplete, not zero');
    const zero = monthlyForecast([{ id: 'h', key: 'RF-3', title: 't', from: '2026-10-07', to: '2026-10-20', rateDate: '2026-10-07', estimates: { be: 0 } }], rates, teams, 'workdays');
    assert.equal(zero.get('2026-10')!.incomplete, 0, 'explicit 0 = no work');
  });
});

async function calendar(app: TestApp, cookie: string) {
  const pv = (await app.call('POST', '/api/calendar/generate-preview', {}, cookie)).body;
  await app.call('POST', '/api/calendar/generate', { plan_hash: pv.plan_hash }, cookie);
}

describe('budget API', () => {
  test('forecast per month, bugs excluded, rate change from a future sprint keeps a closed month (T08, T09, T10)', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    await calendar(app, admin);
    const be = app.one("SELECT id FROM resource_teams WHERE code = 'backend'").id;
    const pr = app.one("SELECT id FROM resource_teams WHERE code = 'product'").id;
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const s82 = app.one("SELECT * FROM sprints WHERE code = '8.2'");
    const mk = async (title: string, est: Record<string, number>, kind = 'planned') => (await app.call('POST', '/api/features', { title, estimates: est, task_kind: kind }, admin)).body.id;
    const a = await mk('A', { [be]: 10, [pr]: 20 });
    const b2 = await mk('B', { [be]: 10 });
    const bug = await mk('Баг', { [be]: 100 }, 'bug');
    await app.call('PATCH', `/api/features/${a}/schedule`, { sprint_id: s81.id, version: 1 }, admin);
    await app.call('PATCH', `/api/features/${b2}/schedule`, { sprint_id: s82.id, version: 1 }, admin);
    await app.call('PATCH', `/api/features/${bug}/schedule`, { sprint_id: s82.id, version: 1 }, admin);
    const rep = (await app.call('GET', '/api/planning/budget?from=2026-10&months=2', undefined, admin)).body;
    const oct = rep.months.find((m: any) => m.month === '2026-10');
    const nov = rep.months.find((m: any) => m.month === '2026-11');
    // A: 10h × 2200 fully in Oct; B: 10h × 2200 split 0.8 / 0.2; the bug costs nothing
    assert.equal(oct.cost, 22000 + 17600);
    assert.equal(nov.cost, 4400);
    assert.equal(oct.hours[pr], 20);
    assert.equal(oct.forecast, true);
    assert.ok(!oct.tasks.some((t: any) => t.id === bug));

    // close October, then raise the Backend rate from sprint 8.2: October stays as frozen, November is recalculated
    const m10 = app.one("SELECT * FROM accounting_months WHERE month = '2026-10'");
    assert.equal((await app.call('POST', '/api/planning/months/2026-10/close', { version: m10.version }, admin)).status, 200);
    assert.equal((await app.call('POST', '/api/admin/team-rates', { team_id: be, rate_rub_per_hour: 3000, include_in_budget: true, effective_sprint_id: s82.id }, admin)).status, 201);
    const rep2 = (await app.call('GET', '/api/planning/budget?from=2026-10&months=2', undefined, admin)).body;
    assert.equal(rep2.months[0].cost, 22000 + 17600, 'closed month unchanged');
    assert.equal(rep2.months[0].status, 'closed');
    assert.equal(rep2.months[1].cost, 6000, 'November share of B at the new rate');
    // history is append-only
    assert.equal((await app.call('POST', '/api/admin/team-rates', { team_id: be, rate_rub_per_hour: 1, include_in_budget: true, effective_sprint_id: s82.id }, admin)).status, 409);
  });

  test('entering a sprint over the monthly budget or capacity needs confirmation with a reason (both checked)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const be = app.one("SELECT id FROM resource_teams WHERE code = 'backend'").id;
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const m = app.one("SELECT * FROM accounting_months WHERE month = '2026-10'");
    assert.equal((await app.call('PUT', '/api/planning/monthly-budget', { month: '2026-10', budget_limit_rub: 10000, version: m.version }, pm)).status, 200);
    assert.equal((await app.call('PUT', '/api/planning/sprint-capacity', { sprint_id: s81.id, team_id: be, hours: 5 }, pm)).status, 200);
    const id = (await app.call('POST', '/api/features', { title: 'Дорогая', estimates: { [be]: 10 } }, pm)).body.id;
    const r = await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s81.id, version: 1 }, pm);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'over_budget');
    assert.deepEqual(r.body.error.details.over.map((o: any) => o.kind).sort(), ['budget', 'capacity']);
    assert.equal(r.body.error.details.over.find((o: any) => o.kind === 'capacity').sprint, '8.1');
    assert.equal((await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s81.id, version: 1, confirm_over_budget: true }, pm)).status, 400, 'reason required');
    assert.equal((await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s81.id, version: 1, confirm_over_budget: true, reason: 'Решение руководства' }, pm)).status, 200);
    const log = app.one("SELECT * FROM audit_log WHERE entity_id = ? AND action = 'scheduled'", id);
    assert.equal(log.is_override, 1);
    // a bug never triggers the check
    const bug = (await app.call('POST', '/api/features', { title: 'Баг', task_kind: 'bug', estimates: { [be]: 100 } }, pm)).body.id;
    assert.equal((await app.call('PATCH', `/api/features/${bug}/schedule`, { sprint_id: s81.id, version: 1 }, pm)).status, 200);
  });

  test('team availability is per sprint: two sprints of one month are checked separately; a closed sprint is frozen', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const be = app.one("SELECT id FROM resource_teams WHERE code = 'backend'").id;
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const s82 = app.one("SELECT * FROM sprints WHERE code = '8.2'");
    await app.call('PUT', '/api/planning/sprint-capacity', { sprint_id: s81.id, team_id: be, hours: 15 }, pm);
    await app.call('PUT', '/api/planning/sprint-capacity', { sprint_id: s82.id, team_id: be, hours: 15 }, pm);
    const mk = async (t: string) => (await app.call('POST', '/api/features', { title: t, estimates: { [be]: 10 } }, pm)).body.id;
    const a = await mk('A');
    const b = await mk('B');
    const c = await mk('C');
    assert.equal((await app.call('PATCH', `/api/features/${a}/schedule`, { sprint_id: s81.id, version: 1 }, pm)).status, 200);
    assert.equal((await app.call('PATCH', `/api/features/${b}/schedule`, { sprint_id: s82.id, version: 1 }, pm)).status, 200, 'another sprint of the same month has its own 15 h');
    const over = await app.call('PATCH', `/api/features/${c}/schedule`, { sprint_id: s81.id, version: 1 }, pm);
    assert.equal(over.status, 409);
    assert.deepEqual(over.body.error.details.over.map((o: any) => [o.sprint, o.value, o.limit]), [['8.1', 20, 15]]);
    const rep = (await app.call('GET', '/api/planning/budget?from=2026-10&months=1', undefined, pm)).body;
    const r81 = rep.sprints.find((s: any) => s.code === '8.1');
    assert.equal(r81.load[be], 10);
    assert.equal(r81.capacity[be], 15);
    app.many("UPDATE sprints SET status = 'closed' WHERE id = ? RETURNING 1", s81.id);
    assert.equal((await app.call('PUT', '/api/planning/sprint-capacity', { sprint_id: s81.id, team_id: be, hours: 99 }, pm)).status, 409);
  });

  test('access: leads cannot read or change budgets; only admins manage rates', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    assert.equal((await app.call('GET', '/api/planning/budget', undefined, lead)).status, 403);
    assert.equal((await app.call('GET', '/api/admin/team-rates', undefined, pm)).status, 403);
    assert.equal((await app.call('GET', '/api/planning/budget', undefined, pm)).status, 200);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup } from './helpers';

describe('capacity and load', () => {
  test('load shows available, planned, free, utilisation and deficit per team', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    const p = (await app.call('GET', '/api/planning', undefined, pm)).body;
    const oct = (team: string) => p.load.find((l: any) => l.periodId === 'per_2026_10' && l.teamId === team);
    // October: RF-1 (60) + RF-2 (80) + RF-17 (80) backend hours, capacity 320
    assert.deepEqual(oct('team_backend'), { periodId: 'per_2026_10', teamId: 'team_backend', capacity: 320, planned: 220, free: 100, utilization: 69, deficit: 0 });
    // DevOps: RF-1 16 + RF-17 80 = 96 of 80 → deficit
    assert.equal(oct('team_devops').deficit, 16);
    assert.equal(oct('team_devops').utilization, 120);
  });

  test('moving a feature into an overloaded period needs explicit confirmation with a reason', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const f = (await app.call('GET', '/api/features/RF-12', undefined, pm)).body.feature; // devops 16, backend 140
    const r1 = await app.call('PATCH', '/api/features/RF-12/placement', { period_id: 'per_2026_10', version: f.version }, pm);
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error.code, 'overload');
    assert.ok(r1.body.error.details.overload.some((o: any) => o.team_name === 'DevOps'));
    const r2 = await app.call('PATCH', '/api/features/RF-12/placement', { period_id: 'per_2026_10', version: f.version, confirm_overload: true }, pm);
    assert.equal(r2.status, 400, 'reason is mandatory');
    const r3 = await app.call('PATCH', '/api/features/RF-12/placement', { period_id: 'per_2026_10', version: f.version, confirm_overload: true, reason: 'Подрядчик DevOps' }, pm);
    assert.equal(r3.status, 200);
    const log = app.one(`SELECT * FROM audit_log WHERE entity_type = 'placement' ORDER BY id DESC LIMIT 1`);
    assert.equal(log.action, 'moved_over_capacity');
    assert.equal(log.reason, 'Подрядчик DevOps');
    // moving into a period with free hours is immediate and recalculates the load
    const g = (await app.call('GET', '/api/features/RF-11', undefined, pm)).body.feature;
    assert.equal((await app.call('PATCH', '/api/features/RF-11/placement', { period_id: 'per_2027_02', version: g.version }, pm)).status, 200);
    const load = (await app.call('GET', '/api/planning', undefined, pm)).body.load.find((l: any) => l.periodId === 'per_2027_02' && l.teamId === 'team_backend');
    assert.equal(load.planned, 24);
  });
});

describe('suggested plan', () => {
  test('respects priorities, dependencies and capacity; explains what does not fit; deterministic', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    const a = (await app.call('POST', '/api/planning/propose', { start_period_id: 'per_2026_10', horizon: 3 }, pm)).body.run;
    const b = (await app.call('POST', '/api/planning/propose', { start_period_id: 'per_2026_10', horizon: 3 }, pm)).body.run;
    assert.equal(a.input_hash, b.input_hash);
    assert.deepEqual(a.placements, b.placements);
    assert.deepEqual(a.unplaced, b.unplaced);
    assert.ok(a.created_at);
    assert.deepEqual(a.params.startPeriodId, 'per_2026_10');
    const at = (key: string) => a.placements.find((p: any) => p.feature.key === key);
    const why = (key: string) => a.unplaced.find((u: any) => u.feature.key === key);
    // fixed placements are kept
    assert.equal(at('RF-1').kind, 'fixed');
    assert.equal(at('RF-3').periodId, 'per_2026_11');
    // dependency: RF-8 is blocked by RF-7 → must be in a later period than RF-7
    const order = ['per_2026_10', 'per_2026_11', 'per_2026_12'];
    if (at('RF-8')) assert.ok(order.indexOf(at('RF-8').periodId) > order.indexOf(at('RF-7').periodId));
    else assert.ok(['dependency', 'capacity'].includes(why('RF-8').code));
    // exclusions with reasons
    assert.equal(why('RF-10').code, 'status');
    assert.equal(why('RF-22').code, 'status');
    assert.equal(why('RF-15').reasons[0], 'Задача отложена');
    // something does not fit into the 3-period horizon and gets a concrete explanation
    const capacity = a.unplaced.filter((u: any) => u.code === 'capacity');
    assert.ok(capacity.length > 0);
    assert.match(capacity[0].reasons[0], /^Не хватает \d+(\.\d)? ч /);
    // only the latest proposal stays active
    assert.equal(app.one(`SELECT status FROM plan_runs WHERE id = ?`, a.id).status, 'discarded');
  });

  test('approval applies placements, locks them and is rejected when inputs changed', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    const run = (await app.call('POST', '/api/planning/propose', { start_period_id: 'per_2026_10', horizon: 3 }, pm)).body.run;
    // a vote changes the priority → the proposal is stale
    const f = (await app.call('GET', '/api/features/RF-23', undefined, pm)).body.feature;
    assert.equal((await app.call('PUT', '/api/features/RF-23/votes/dep_product', { score: 5, expected_version: null }, pm)).status, 200);
    const stale = await app.call('POST', `/api/planning/runs/${run.id}/approve`, {}, pm);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'stale');
    assert.ok(f);
    // fresh proposal → approve a subset
    const run2 = (await app.call('POST', '/api/planning/propose', { start_period_id: 'per_2026_10', horizon: 3 }, pm)).body.run;
    const proposed = run2.placements.filter((p: any) => p.kind === 'proposed');
    const pick = proposed.slice(0, 2);
    const ok = await app.call('POST', `/api/planning/runs/${run2.id}/approve`, { feature_ids: pick.map((p: any) => p.featureId) }, pm);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.applied, 2);
    for (const p of pick) {
      const row = app.one('SELECT period_id, placement_locked, status_id FROM features WHERE id = ?', p.featureId);
      assert.equal(row.period_id, p.periodId);
      assert.equal(row.placement_locked, 1);
      assert.equal(row.status_id, 'st_f_planned');
    }
    const notPicked = proposed[2];
    assert.equal(app.one('SELECT period_id FROM features WHERE id = ?', notPicked.featureId).period_id, null, 'nothing is applied automatically');
    assert.equal((await app.call('POST', `/api/planning/runs/${run2.id}/approve`, {}, pm)).status, 409, 'cannot approve twice');
  });

  test('department lead cannot plan', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    assert.equal((await app.call('POST', '/api/planning/propose', {}, lead)).status, 403);
    assert.equal((await app.call('PUT', '/api/planning/capacity', { period_id: 'per_2026_10', team_id: 'team_backend', hours: 1, version: 1 }, lead)).status, 403);
  });
});

describe('approved plan stability', () => {
  test('capacity, weight or estimate changes raise a review alert but never move approved work', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin', ['dep_product']);
    const before = {
      placements: app.many('SELECT id, period_id, placement_locked FROM features ORDER BY id'),
      releases: app.many('SELECT * FROM release_features ORDER BY feature_id'),
      approved: app.many('SELECT id, approved_at, planned_date FROM releases ORDER BY id'),
    };
    const cap = app.one(`SELECT version FROM team_capacities WHERE period_id = 'per_2026_11' AND team_id = 'team_backend'`);
    assert.equal((await app.call('PUT', '/api/planning/capacity', { period_id: 'per_2026_11', team_id: 'team_backend', hours: 60, version: cap.version }, admin)).status, 200);
    const dep = app.one(`SELECT version FROM departments WHERE id = 'dep_sales'`);
    assert.equal((await app.call('PATCH', '/api/admin/dict/departments/dep_sales', { weight: 3, version: dep.version }, admin)).status, 200);
    const est = app.one(`SELECT version FROM feature_estimates WHERE feature_id = 'feat_003' AND team_id = 'team_backend'`);
    assert.equal((await app.call('PUT', '/api/features/RF-3/estimates', { estimates: { team_backend: 160 }, versions: { team_backend: est.version } }, admin)).status, 200);
    const alerts = (await app.call('GET', '/api/planning/alerts', undefined, admin)).body.alerts.map((a: any) => a.kind).sort();
    assert.deepEqual(alerts, ['capacity_changed', 'department_weight', 'estimate_changed']);
    assert.deepEqual(app.many('SELECT id, period_id, placement_locked FROM features ORDER BY id'), before.placements);
    assert.deepEqual(app.many('SELECT * FROM release_features ORDER BY feature_id'), before.releases);
    assert.deepEqual(app.many('SELECT id, approved_at, planned_date FROM releases ORDER BY id'), before.approved);
    // the deficit is visible
    const load = (await app.call('GET', '/api/planning', undefined, admin)).body.load.find((l: any) => l.periodId === 'per_2026_11' && l.teamId === 'team_backend');
    assert.equal(load.deficit, 100);
    // changing an unrelated, unapproved period does not raise an alert
    const cap2 = app.one(`SELECT version FROM team_capacities WHERE period_id = 'per_2027_03' AND team_id = 'team_qa'`);
    await app.call('PUT', '/api/planning/capacity', { period_id: 'per_2027_03', team_id: 'team_qa', hours: 10, version: cap2.version }, admin);
    assert.equal((await app.call('GET', '/api/planning/alerts', undefined, admin)).body.alerts.length, 3);
    assert.equal((await app.call('POST', '/api/planning/alerts/all/resolve', {}, admin)).status, 200);
    assert.equal((await app.call('GET', '/api/planning/alerts', undefined, admin)).body.alerts.length, 0);
  });

  test('changing an approved release composition requires confirmation and a reason', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const rel = (await app.call('GET', '/api/releases/rel_1', undefined, pm)).body.release;
    const r1 = await app.call('PUT', '/api/releases/rel_1/features', { feature_ids: [...rel.feature_ids, 'feat_011'], version: rel.version }, pm);
    assert.equal(r1.status, 409);
    const r2 = await app.call('PUT', '/api/releases/rel_1/features', { feature_ids: [...rel.feature_ids, 'feat_011'], version: rel.version, confirm_approved_change: true, reason: 'Решение комитета' }, pm);
    assert.equal(r2.status, 200);
    const log = app.one(`SELECT * FROM audit_log WHERE entity_type = 'release' AND action = 'composition_changed' ORDER BY id DESC LIMIT 1`);
    assert.equal(log.is_override, 1);
    assert.equal(log.reason, 'Решение комитета');
  });
});

describe('roadmap', () => {
  test('shows features by period/lane with releases, planned dates and blockers', async () => {
    const app = await setup();
    const r = (await app.call('GET', '/api/roadmap')).body;
    assert.ok(r.periods.length >= 3);
    const lane = (k: string) => r.features.find((f: any) => f.key === k)?.lane;
    assert.equal(lane('RF-1'), 'now');
    assert.equal(lane('RF-18'), 'done');
    const rel1 = r.releases.find((x: any) => x.id === 'rel_1');
    assert.equal(rel1.planned_date, '2026-11-25');
    assert.equal(rel1.approved, true);
    const rel2 = (await app.call('GET', '/api/releases/rel_2')).body.release;
    assert.ok(rel2.feature_count >= 3);
    // RF-7 is in release 2 — release blockers list features with open blocking tasks (none for rel_2 publicly)
    assert.ok(Array.isArray(rel2.blockers));
    assert.equal(r.load, null, 'guest does not see capacity by default');
  });
});

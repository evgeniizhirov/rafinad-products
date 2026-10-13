import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers';

test('smoke: public endpoints respond for guests', async () => {
  const app = await setup();
  for (const path of ['/api/meta', '/api/features', '/api/epics', '/api/priorities', '/api/gantt', '/api/releases', '/api/overview', '/api/graph']) {
    const r = await app.call('GET', path);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
});

test('smoke: employee endpoints respond', async () => {
  const app = await setup();
  const admin = await app.user('admin@test.io', 'admin', ['dep_product']);
  for (const path of ['/api/auth/me', '/api/planner', '/api/import/sources', '/api/import/runs', '/api/admin/users', '/api/admin/audit', '/api/features/RF-1', '/api/features/1/merge-preview?target_id=RF-2']) {
    const r = await app.call('GET', path, undefined, admin);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
});

test('retired: the old planning periods, auto-planner, plan alerts and roadmap answer 410 for everyone (v2-10)', async () => {
  const app = await setup();
  const admin = await app.user('admin@test.io', 'admin', ['dep_product']);
  const calls: [string, string][] = [
    ['GET', '/api/roadmap'], ['GET', '/api/planning'], ['PUT', '/api/planning/capacity'], ['POST', '/api/planning/propose'],
    ['GET', '/api/planning/runs/x'], ['POST', '/api/planning/runs/x/approve'], ['GET', '/api/planning/alerts'], ['PATCH', '/api/features/RF-1/placement'],
  ];
  for (const [m, p] of calls) {
    for (const who of [null, admin]) {
      const r = await app.call(m, p, m === 'GET' ? undefined : {}, who);
      assert.equal(r.status, 410, `${m} ${p}`);
      assert.match(r.body.error.message, /спринтам/);
    }
  }
  // budget and sprint capacity stay under /api/planning/*
  assert.equal((await app.call('GET', '/api/planning/budget', undefined, admin)).status, 200);
  // compatibility keys stay in the answers (MCP)
  const ov = (await app.call('GET', '/api/overview', undefined, admin)).body;
  assert.deepEqual([ov.periods, ov.load, ov.alerts], [[], null, 0]);
  const card = (await app.call('GET', '/api/features/RF-1', undefined, admin)).body.feature;
  assert.equal(card.period, null);
  assert.equal(card.placement_locked, false);
  assert.equal((await app.call('GET', '/api/features?period=per_2026_10', undefined, admin)).body.total, 0);
  // the tables are gone
  assert.equal(app.one("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('capacity_periods', 'team_capacities', 'plan_runs', 'plan_alerts')").n, 0);
});

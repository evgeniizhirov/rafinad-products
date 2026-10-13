// P09 / FR-11: analytics on a data set with known dates and transitions.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { percentile } from '../worker/domain/analytics';
import { setup, type TestApp } from './helpers';

const st = (app: TestApp, sem: string) => app.one("SELECT id FROM statuses WHERE entity = 'feature' AND semantic = ? ORDER BY sort_order LIMIT 1", sem).id;

async function mk(app: TestApp, cookie: string, body: Record<string, unknown>) {
  const r = await app.call('POST', '/api/features', body, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}
async function setStatus(app: TestApp, cookie: string, id: string, sem: string, at: string) {
  const v = app.one('SELECT version FROM features WHERE id = ?', id).version;
  assert.equal((await app.call('PATCH', `/api/features/${id}`, { status_id: st(app, sem), version: v }, cookie)).status, 200);
  // pin the time of the transition to a known date
  app.many("UPDATE audit_log SET at = ? WHERE id = (SELECT MAX(id) FROM audit_log WHERE entity_id = ? AND action = 'updated') RETURNING 1", at, id);
}

const Q = 'from=2026-01-01&to=2026-12-31';

describe('analytics', () => {
  test('percentile', () => {
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(percentile([], 0.5), null);
  });

  test('cycle time, timeliness against the first promise, author ≠ initiator, renaming a status changes nothing (T17)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', [], 'Анна ПМ');
    const ids: string[] = [];
    for (const [i, d] of [[1, 4], [2, 6], [3, 10]] as const) {
      const id = await mk(app, pm, { title: `Баг ${i}`, task_kind: 'bug', initiator: { type: 'department', department_id: 'dep_finance' } });
      await setStatus(app, pm, id, 'in_progress', '2026-03-01T10:00:00.000Z');
      await setStatus(app, pm, id, 'done', `2026-03-${String(1 + d).padStart(2, '0')}T10:00:00.000Z`);
      app.many('UPDATE features SET closed_at = ? WHERE id = ? RETURNING 1', `2026-03-${String(1 + d).padStart(2, '0')}`, id);
      ids.push(id);
    }
    // timeliness: first promise 2026-03-05, later moved to 2026-03-20; closed 2026-03-10 → late (baseline counts, not the last date)
    const late = await mk(app, pm, { title: 'Обещали к 5-му' });
    app.many("UPDATE features SET baseline_production_date = '2026-03-05', planned_production_date = '2026-03-20', status_id = ?, closed_at = '2026-03-10' WHERE id = ? RETURNING 1", st(app, 'done'), late);
    const onTime = await mk(app, pm, { title: 'В срок' });
    app.many("UPDATE features SET baseline_production_date = '2026-03-15', status_id = ?, closed_at = '2026-03-14' WHERE id = ? RETURNING 1", st(app, 'done'), onTime);
    const noBaseline = await mk(app, pm, { title: 'Без обещания' });
    app.many("UPDATE features SET status_id = ?, closed_at = '2026-03-14' WHERE id = ? RETURNING 1", st(app, 'done'), noBaseline);

    const a = (await app.call('GET', `/api/analytics/summary?${Q}`, undefined, pm)).body;
    assert.equal(a.cycle_time.bugs.value, 6, 'median of 4, 6, 10 days');
    assert.equal(a.cycle_time.bugs.extra.n, 3);
    assert.ok(a.cycle_time.planned.insufficient, 'not enough planned tasks with history → no fake number');
    assert.equal(a.timeliness.value, 50);
    assert.deepEqual(a.timeliness.ids, [onTime]);
    assert.ok(a.timeliness.extra.without_baseline.includes(noBaseline));
    assert.equal(a.volume.bugs_resolved.value, 3);
    const author = a.creators.by_author.find((x: any) => x.name === 'Анна ПМ');
    assert.ok(author.count >= 6);
    const ini = a.creators.by_initiator.find((x: any) => x.name === 'Финансы (отдел)');
    assert.equal(ini.count, 3);

    // rename a status: the same semantic → identical figures
    app.many("UPDATE statuses SET name = 'Сделано!!' WHERE id = ? RETURNING 1", st(app, 'done'));
    const b = (await app.call('GET', `/api/analytics/summary?${Q}`, undefined, pm)).body;
    assert.deepEqual(b.volume, a.volume);
    assert.deepEqual(b.cycle_time, a.cycle_time);
    assert.deepEqual(b.timeliness, a.timeliness);
  });

  test('demand: high priority share, strictly 5, "delivered without postponing" only with history; missing history is flagged (T19)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    // a new task with history: high score, postponed once, then done → not "clean"
    const f = await mk(app, pm, { title: 'Высокий приоритет' });
    for (const d of ['dep_sales', 'dep_finance', 'dep_affiliates', 'dep_support']) {
      app.many("INSERT INTO department_votes (feature_id, department_id, score, voted_at) VALUES (?, ?, 5, '2026-02-01') RETURNING 1", f, d);
    }
    await setStatus(app, pm, f, 'postponed', '2026-02-02T10:00:00.000Z');
    await setStatus(app, pm, f, 'done', '2026-02-10T10:00:00.000Z');
    // a seed task (no creation record) with high score and done → "no history", not "clean"
    const seed = app.one('SELECT id FROM features WHERE number = 1').id;
    app.many('UPDATE features SET status_id = ? WHERE id = ? RETURNING 1', st(app, 'done'), seed);
    const a = (await app.call('GET', `/api/analytics/summary?${Q}`, undefined, pm)).body;
    assert.equal(a.demand.threshold, 4);
    assert.ok(a.demand.high.ids.includes(f));
    assert.ok(a.demand.strictly_5.ids.includes(f));
    const dd = a.demand.demanded_delivered;
    assert.ok(!dd.ids.includes(f), 'postponed once → not counted as delivered without postponing');
    if (dd.value === null) assert.match(dd.insufficient, /истори/);
    else assert.ok(dd.extra.no_history >= 1, 'seed tasks without history are counted separately');
  });

  test('a task created through an API key is attributed to the key owner and counted as "via API key" (T18)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', [], 'Борис Ключ');
    const token = (await app.call('POST', '/api/me/api-keys', { name: 'bot', scopes: ['tasks:read', 'tasks:create'] }, pm)).body.token;
    const r = await app.call('POST', '/api/features', { title: 'Из интеграции', initiator: { type: 'department', department_id: 'dep_sales' } }, null, { authorization: `Bearer ${token}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const a = (await app.call('GET', `/api/analytics/summary?${Q}`, undefined, pm)).body;
    const author = a.creators.by_author.find((x: any) => x.name === 'Борис Ключ');
    assert.equal(author.via_api_key, 1);
    assert.ok(author.ids.includes(r.body.id));
    assert.ok(a.creators.by_initiator.some((x: any) => x.name.startsWith('Продажи') && x.ids.includes(r.body.id)));
    // a key with tasks:read can read analytics
    const ro = (await app.call('POST', '/api/me/api-keys', { name: 'ro', scopes: ['tasks:read'] }, pm)).body.token;
    assert.equal((await app.call('GET', `/api/analytics/summary?${Q}`, undefined, null, { authorization: `Bearer ${ro}` })).status, 200);
  });

  test('hidden Product tasks are not in any figure or drill-down; drill-down re-applies ACL', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const hidden = await mk(app, pm, { title: 'Скрытая аналитика', is_product_internal: true, task_kind: 'bug' });
    for (const cookie of [pm, lead]) {
      const a = await app.call('GET', `/api/analytics/summary?${Q}&internal=all`, undefined, cookie);
      assert.equal(a.status, 200);
      assert.ok(!JSON.stringify(a.body).includes(hidden));
    }
    const drill = await app.call('GET', `/api/features?ids=${hidden}`, undefined, lead);
    assert.equal(drill.body.total, 0);
    assert.equal((await app.call('GET', '/api/analytics/summary', undefined, null)).status, 401);
  });
});

// P02: work type (FR-07 base), hidden Product tasks (FR-02), initiator (FR-10).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup, type TestApp } from './helpers';

const SECRET = 'Секретная проработка тарифов';

async function hiddenTask(app: TestApp, pm: string) {
  const epic = app.one('SELECT id FROM epics ORDER BY number LIMIT 1').id;
  const offer = app.one('SELECT id FROM offers ORDER BY name LIMIT 1').id;
  const r = await app.call('POST', '/api/features', {
    title: SECRET, description: 'не для отделов', visibility: 'public', is_product_internal: true,
    epic_id: epic, offer_ids: [offer], tags: ['тайна'], estimates: { team_backend: 40 },
  }, pm);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id as string;
  // a relation to a general task and a vote of the product department
  assert.equal((await app.call('POST', `/api/features/${id}/relations`, { type: 'blocks', target_id: 'RF-4' }, pm)).status, 201);
  return { id, key: r.body.key as string };
}

const text = (body: unknown) => JSON.stringify(body);

describe('hidden Product tasks (FR-02)', () => {
  test('nobody but product/admin can find a hidden task through any endpoint', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const { id, key } = await hiddenTask(app, pm);

    for (const [who, cookie] of [['guest', null], ['lead', lead]] as const) {
      for (const path of [
        '/api/features', '/api/features?internal=all', '/api/features?internal=1', `/api/features?q=${encodeURIComponent('тариф')}`,
        '/api/overview', '/api/roadmap', '/api/priorities', '/api/graph', '/api/releases', '/api/epics', '/api/offers', '/api/features/RF-4',
      ]) {
        const r = await app.call('GET', path, undefined, cookie);
        assert.ok(r.status === 200, `${who} ${path}: ${r.status}`);
        assert.ok(!text(r.body).includes(SECRET) && !text(r.body).includes(id), `${who} ${path} leaks the hidden task`);
      }
      // a relation to the hidden task is not even shown as "hidden"
      const rf4 = (await app.call('GET', '/api/features/RF-4', undefined, cookie)).body.feature;
      assert.equal(rf4.relations.blocked_by.length, 0, `${who}: no hidden placeholder`);
      assert.equal(rf4.open_blockers, 0);
      // direct access: same 404 as a missing id
      for (const ref of [id, key]) {
        const r = await app.call('GET', `/api/features/${ref}`, undefined, cookie);
        assert.equal(r.status, 404, `${who} GET ${ref}`);
        assert.equal(r.body.error.message, 'Задача не найдена');
      }
    }
    // writes by a lead: 404, nothing written
    assert.equal((await app.call('POST', `/api/features/${id}/comments`, { body: 'привет' }, lead)).status, 404);
    assert.equal((await app.call('PUT', `/api/features/${id}/votes/dep_sales`, { score: 5, expected_version: null }, lead)).status, 404);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM department_votes WHERE feature_id = ?', id).n, 0);

    // counters are identical to a world without the task
    const kLead = (await app.call('GET', '/api/overview', undefined, lead)).body.kpi;
    app.many('DELETE FROM feature_relations WHERE from_id = ? RETURNING 1', id);
    app.many('DELETE FROM feature_estimates WHERE feature_id = ? RETURNING 1', id);
    app.many('DELETE FROM feature_tags WHERE feature_id = ? RETURNING 1', id);
    app.many('DELETE FROM feature_offers WHERE feature_id = ? RETURNING 1', id);
    app.many('DELETE FROM features WHERE id = ? RETURNING 1', id);
    assert.deepEqual((await app.call('GET', '/api/overview', undefined, lead)).body.kpi, kLead);
  });

  test('product sees hidden tasks only on request; general views exclude them for product too', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    const { id } = await hiddenTask(app, pm);
    const general = (await app.call('GET', '/api/features', undefined, pm)).body.features;
    assert.ok(!general.some((f: any) => f.id === id), 'general backlog excludes hidden tasks');
    const only = (await app.call('GET', '/api/features?internal=1', undefined, pm)).body.features;
    assert.deepEqual(only.map((f: any) => f.id), [id]);
    assert.equal(only[0].is_product_internal, true);
    const all = (await app.call('GET', '/api/features?internal=all', undefined, pm)).body.features;
    assert.ok(all.some((f: any) => f.id === id) && all.length === general.length + 1);
    const card = await app.call('GET', `/api/features/${id}`, undefined, pm);
    assert.equal(card.status, 200);
    assert.equal(card.body.feature.relations.blocks.length, 1);
    for (const path of ['/api/overview', '/api/roadmap', '/api/priorities', '/api/epics', '/api/offers', '/api/graph']) {
      assert.ok(!text((await app.call('GET', path, undefined, pm)).body).includes(SECRET), `${path} excludes hidden tasks for product too`);
    }
    // the planner ignores it
    const plan = await app.call('POST', '/api/planning/propose', {}, pm);
    assert.equal(plan.status, 201, text(plan.body));
    assert.ok(!text(plan.body).includes(id));
  });

  test('hidden tasks cannot enter releases or periods; disclosure needs confirmation and is audited', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const { id } = await hiddenTask(app, admin);
    const rel = app.one("SELECT id, version FROM releases WHERE approved_at IS NULL LIMIT 1");
    const current = app.many('SELECT feature_id FROM release_features WHERE release_id = ?', rel.id).map((x: any) => x.feature_id);
    const add = await app.call('PUT', `/api/releases/${rel.id}/features`, { feature_ids: [...current, id], version: rel.version }, admin);
    assert.equal(add.status, 400);
    const period = app.one('SELECT id FROM capacity_periods LIMIT 1').id;
    const f = () => app.one('SELECT * FROM features WHERE id = ?', id);
    assert.equal((await app.call('PATCH', `/api/features/${id}/placement`, { period_id: period, version: f().version }, admin)).status, 400);

    const noConfirm = await app.call('PATCH', `/api/features/${id}`, { is_product_internal: false, version: f().version }, admin);
    assert.equal(noConfirm.status, 409);
    assert.equal(noConfirm.body.error.code, 'confirm_disclose');
    assert.equal(f().is_product_internal, 1);
    const ok = await app.call('PATCH', `/api/features/${id}`, { is_product_internal: false, confirm_disclose: true, version: f().version }, admin);
    assert.equal(ok.status, 200, text(ok.body));
    assert.equal((await app.call('GET', `/api/features/${id}`, undefined, lead)).status, 200, 'now visible to departments');
    const log = app.one("SELECT changes FROM audit_log WHERE entity_type = 'feature' AND entity_id = ? AND action = 'updated' ORDER BY id DESC LIMIT 1", id);
    assert.deepEqual(JSON.parse(log.changes), [{ field: 'is_product_internal', old: 1, new: 0 }]);

    // a task in a release cannot be hidden
    const inRel = app.one('SELECT f.id, f.version FROM features f JOIN release_features rf ON rf.feature_id = f.id LIMIT 1');
    assert.equal((await app.call('PATCH', `/api/features/${inRel.id}`, { is_product_internal: true, version: inRel.version }, admin)).status, 400);
  });

  test('department leads cannot create or flip hidden tasks', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    assert.equal((await app.call('POST', '/api/features', { title: 'x', is_product_internal: true }, lead)).status, 403);
    assert.equal((await app.call('PATCH', '/api/features/RF-4', { is_product_internal: true, version: 1 }, lead)).status, 403);
  });
});

describe('work type (FR-07 base)', () => {
  test('existing tasks are planned; kind is validated, filterable and kept out of planning and releases', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    assert.equal(app.one("SELECT COUNT(*) AS n FROM features WHERE task_kind <> 'planned'").n, 0);
    assert.equal((await app.call('POST', '/api/features', { title: 'x', task_kind: 'feature' }, pm)).status, 400);
    const bug = await app.call('POST', '/api/features', { title: 'Не считается баланс', task_kind: 'bug', estimates: { team_backend: 8 } }, pm);
    assert.equal(bug.status, 201);
    const imp = await app.call('POST', '/api/features', { title: 'Добавить колонку в выгрузку', task_kind: 'operational_improvement' }, pm);
    assert.equal(imp.status, 201);
    const bugs = (await app.call('GET', '/api/features?kind=bug', undefined, pm)).body.features;
    assert.deepEqual(bugs.map((f: any) => f.key), [bug.body.key]);
    assert.equal(bugs[0].task_kind, 'bug');
    const both = (await app.call('GET', '/api/features?kind=bug,operational_improvement', undefined, pm)).body.features;
    assert.equal(both.length, 2);
    // bug: visible in general lists (it is real work), but never planned or put into a release
    assert.ok((await app.call('GET', '/api/features', undefined, pm)).body.features.some((f: any) => f.id === bug.body.id));
    const plan = (await app.call('POST', '/api/planning/propose', {}, pm)).body;
    assert.ok(!text(plan).includes(bug.body.id));
    const period = app.one('SELECT id FROM capacity_periods LIMIT 1').id;
    assert.equal((await app.call('PATCH', `/api/features/${bug.body.id}/placement`, { period_id: period, version: 1 }, pm)).status, 400);
    const rel = app.one('SELECT id, version FROM releases WHERE approved_at IS NULL LIMIT 1');
    const cur = app.many('SELECT feature_id FROM release_features WHERE release_id = ?', rel.id).map((x: any) => x.feature_id);
    assert.equal((await app.call('PUT', `/api/releases/${rel.id}/features`, { feature_ids: [...cur, bug.body.id], version: rel.version }, pm)).status, 400);
    // converting a released task into a bug is refused
    const inRel = app.one('SELECT f.id, f.version FROM features f JOIN release_features rf ON rf.feature_id = f.id LIMIT 1');
    assert.equal((await app.call('PATCH', `/api/features/${inRel.id}`, { task_kind: 'bug', version: inRel.version }, pm)).status, 400);
    // a bug converted into a planned task becomes plannable
    const b = app.one('SELECT version FROM features WHERE id = ?', bug.body.id);
    assert.equal((await app.call('PATCH', `/api/features/${bug.body.id}`, { task_kind: 'planned', version: b.version }, pm)).status, 200);
    assert.equal((await app.call('PATCH', `/api/features/${bug.body.id}/placement`, { period_id: period, version: b.version + 1, confirm_overload: true, reason: 'тест' }, pm)).status, 200);
  });
});

describe('initiator (FR-10)', () => {
  test('free text, user and department; snapshot survives renames; filters work; author is separate', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', [], 'Анна ПМ');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales'], 'Игорь Продажи');
    const leadId = app.one("SELECT id FROM users WHERE email = 'lead@test.io'").id;

    const dir = await app.call('GET', '/api/users/directory', undefined, pm);
    assert.equal(dir.status, 200);
    assert.ok(dir.body.users.some((u: any) => u.id === leadId && !('email' in u)));
    assert.equal((await app.call('GET', '/api/users/directory', undefined, lead)).status, 403);

    const mk = async (initiator: unknown) => {
      const r = await app.call('POST', '/api/features', { title: `Задача ${JSON.stringify(initiator)}`, initiator }, pm);
      assert.equal(r.status, 201, text(r.body));
      return r.body.key as string;
    };
    const free = await mk({ type: 'free_text', name: 'Петров Пётр' });
    const byUser = await mk({ type: 'user', user_id: leadId });
    const byDept = await mk({ type: 'department', department_id: 'dep_finance' });
    const none = await mk(null);
    assert.equal((await app.call('POST', '/api/features', { title: 'x', initiator: { type: 'user', user_id: 'u_nope' } }, pm)).status, 400);
    assert.equal((await app.call('POST', '/api/features', { title: 'x', initiator: { type: 'free_text', name: '  ' } }, pm)).status, 400);

    const get = async (key: string, cookie = pm) => (await app.call('GET', `/api/features/${key}`, undefined, cookie)).body.feature;
    assert.deepEqual((await get(free)).initiator, { type: 'free_text', name: 'Петров Пётр' });
    assert.equal((await get(byUser)).initiator.name, 'Игорь Продажи');
    assert.equal((await get(byUser)).author_name, 'Анна ПМ', 'author stays the creator');
    assert.equal((await get(byDept)).initiator.name, 'Финансы');
    assert.equal((await get(none)).initiator, null);

    // rename / deactivate: current name shown, snapshot kept for a deleted reference
    app.many("UPDATE departments SET name = 'Финансовый отдел' WHERE id = 'dep_finance' RETURNING 1");
    assert.equal((await get(byDept)).initiator.name, 'Финансовый отдел');
    app.many('UPDATE users SET is_active = 0 WHERE id = ? RETURNING 1', leadId);
    const ini = (await get(byUser)).initiator;
    assert.equal(ini.name, 'Игорь Продажи');
    assert.equal(ini.inactive, true);
    app.many("UPDATE features SET initiator_user_id = NULL WHERE number = ? RETURNING 1", Number(byUser.slice(3)));
    assert.equal((await get(byUser)).initiator.name, 'Игорь Продажи', 'snapshot when the user row is gone');

    const keys = async (q: string) => (await app.call('GET', `/api/features?sort=number&initiator=${encodeURIComponent(q)}`, undefined, pm)).body.features.map((f: any) => f.key);
    assert.deepEqual(await keys(`department:dep_finance`), [byDept]);
    assert.deepEqual(await keys('text:петров'), [free]);
    assert.ok((await keys('none')).includes(none));

    // edit with history; guests never get the initiator
    const f = app.one('SELECT id, version FROM features WHERE number = ?', Number(free.slice(3)));
    assert.equal((await app.call('PATCH', `/api/features/${f.id}`, { initiator: { type: 'department', department_id: 'dep_sales' }, version: f.version }, pm)).status, 200);
    const log = JSON.parse(app.one("SELECT changes FROM audit_log WHERE entity_id = ? AND action = 'updated' ORDER BY id DESC LIMIT 1", f.id).changes);
    assert.ok(log.some((c: any) => c.field === 'initiator_type' && c.old === 'free_text' && c.new === 'department'));
    app.many("UPDATE features SET visibility = 'public' WHERE id = ? RETURNING 1", f.id);
    const pub = (await app.call('GET', `/api/features/${free}`, undefined, null)).body.feature;
    assert.equal(pub.initiator, undefined);
  });
});

// FR-04 / P01: a department vote can be cast only on behalf of the voter's own departments.
// Matrix: analytics lead, finance lead, member of two departments, user without departments,
// admin (override with reason), disabled user, membership change, forged requests.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup, type TestApp } from './helpers';

const F = 'RF-4';

async function voteVersion(app: TestApp, cookie: string, dept: string): Promise<number | null> {
  const f = (await app.call('GET', `/api/features/${F}`, undefined, cookie)).body.feature;
  return f.votes.find((v: any) => v.department_id === dept)?.version ?? null;
}

const put = (app: TestApp, cookie: string | null, dept: string, body: Record<string, unknown>) =>
  app.call('PUT', `/api/features/${F}/votes/${dept}`, body, cookie);

const score = (app: TestApp, dept: string) => app.one('SELECT score FROM department_votes WHERE feature_id = (SELECT id FROM features WHERE number = 4) AND department_id = ?', dept)?.score ?? null;

describe('votes ACL (FR-04)', () => {
  test('a lead votes for own department only; a forged request for another department is 403 and changes nothing', async () => {
    const app = await setup();
    const analytics = await app.user('an@test.io', 'department_lead', ['dep_affiliates']);
    const finance = await app.user('fin@test.io', 'department_lead', ['dep_finance']);

    const before = score(app, 'dep_finance');
    const forged = await put(app, analytics, 'dep_finance', { score: 1, expected_version: await voteVersion(app, analytics, 'dep_finance') });
    assert.equal(forged.status, 403);
    assert.equal(score(app, 'dep_finance'), before, 'foreign vote must not change');
    // a reason does not turn a non-admin into an admin
    assert.equal((await put(app, analytics, 'dep_finance', { score: 1, expected_version: null, reason: 'очень надо' })).status, 403);

    const own = await put(app, analytics, 'dep_affiliates', { score: 5, expected_version: await voteVersion(app, analytics, 'dep_affiliates') });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(score(app, 'dep_affiliates'), 5);

    const fin = await put(app, finance, 'dep_finance', { score: 2, expected_version: await voteVersion(app, finance, 'dep_finance') });
    assert.equal(fin.status, 200);
    assert.equal((await put(app, finance, 'dep_affiliates', { score: 1, expected_version: 1 })).status, 403);
    const log = app.one("SELECT * FROM audit_log WHERE entity_type = 'vote' ORDER BY id DESC LIMIT 1");
    assert.equal(log.action, 'vote');
    assert.equal(log.is_override, 0);
  });

  test('member of two departments votes for both', async () => {
    const app = await setup();
    const both = await app.user('two@test.io', 'department_lead', ['dep_sales', 'dep_support']);
    for (const dept of ['dep_sales', 'dep_support']) {
      const r = await put(app, both, dept, { score: 4, expected_version: await voteVersion(app, both, dept) });
      assert.equal(r.status, 200, `${dept}: ${JSON.stringify(r.body)}`);
      assert.equal(score(app, dept), 4);
    }
    assert.equal((await put(app, both, 'dep_finance', { score: 4, expected_version: null })).status, 403);
  });

  test('user without departments cannot vote at all; guests get 401', async () => {
    const app = await setup();
    const nobody = await app.user('none@test.io', 'department_lead', []);
    for (const dept of ['dep_sales', 'dep_product', 'dep_finance']) {
      assert.equal((await put(app, nobody, dept, { score: 3, expected_version: null })).status, 403);
    }
    const pm = await app.user('pm@test.io', 'product', []);
    assert.equal((await put(app, pm, 'dep_product', { score: 3, expected_version: null })).status, 403, 'product role alone gives no vote');
    assert.equal((await put(app, null, 'dep_sales', { score: 3, expected_version: null })).status, 401);
  });

  test('stale expected_version is rejected with 409 and the current value', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const v = await voteVersion(app, lead, 'dep_sales');
    assert.equal((await put(app, lead, 'dep_sales', { score: 1, expected_version: v })).status, 200);
    const stale = await put(app, lead, 'dep_sales', { score: 2, expected_version: v });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');
    assert.equal(stale.body.error.details.current.score, 1);
    assert.equal(score(app, 'dep_sales'), 1);
  });

  test('admin: own department as usual, foreign one only with a reason; both outcomes audited', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin', ['dep_product']);
    const ownV = await voteVersion(app, admin, 'dep_product');
    assert.equal((await put(app, admin, 'dep_product', { score: 3, expected_version: ownV })).status, 200);
    assert.equal(app.one("SELECT is_override FROM audit_log WHERE entity_type = 'vote' ORDER BY id DESC LIMIT 1").is_override, 0);

    const v = await voteVersion(app, admin, 'dep_finance');
    const before = score(app, 'dep_finance');
    const noReason = await put(app, admin, 'dep_finance', { score: 1, expected_version: v });
    assert.equal(noReason.status, 400);
    assert.equal((await put(app, admin, 'dep_finance', { score: 1, expected_version: v, reason: '   ' })).status, 400, 'blank reason is not a reason');
    assert.equal(score(app, 'dep_finance'), before);
    const ok = await put(app, admin, 'dep_finance', { score: 1, expected_version: v, reason: 'Решение совета' });
    assert.equal(ok.status, 200);
    const log = app.one("SELECT * FROM audit_log WHERE entity_type = 'vote' ORDER BY id DESC LIMIT 1");
    assert.equal(log.action, 'vote_admin_override');
    assert.equal(log.is_override, 1);
    assert.equal(log.reason, 'Решение совета');
    // removing a foreign vote is an override too
    const v2 = await voteVersion(app, admin, 'dep_finance');
    assert.equal((await put(app, admin, 'dep_finance', { score: null, expected_version: v2 })).status, 400);
    assert.equal((await put(app, admin, 'dep_finance', { score: null, expected_version: v2, reason: 'Снято по решению совета' })).status, 200);
    assert.equal(score(app, 'dep_finance'), null);
  });

  test('membership changes apply immediately to existing sessions', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const leadId = app.one("SELECT id FROM users WHERE email = 'lead@test.io'").id;
    const version = () => app.one('SELECT version FROM users WHERE id = ?', leadId).version;

    assert.equal((await put(app, lead, 'dep_sales', { score: 2, expected_version: await voteVersion(app, lead, 'dep_sales') })).status, 200);
    const moved = await app.call('PATCH', `/api/admin/users/${leadId}`, { department_ids: ['dep_finance'], version: version() }, admin);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    // same cookie, no re-login
    assert.equal((await put(app, lead, 'dep_sales', { score: 3, expected_version: await voteVersion(app, lead, 'dep_sales') })).status, 403);
    assert.equal((await put(app, lead, 'dep_finance', { score: 3, expected_version: await voteVersion(app, lead, 'dep_finance') })).status, 200);
    const me = (await app.call('GET', '/api/auth/me', undefined, lead)).body.user;
    assert.deepEqual(me.department_ids, ['dep_finance'], 'UI receives the new membership too');
  });

  test('disabled user cannot vote with an old session; inactive department cannot be voted for', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales', 'dep_support']);
    const leadId = app.one("SELECT id FROM users WHERE email = 'lead@test.io'").id;

    app.many("UPDATE departments SET is_active = 0 WHERE id = 'dep_support' RETURNING 1");
    assert.equal((await put(app, lead, 'dep_support', { score: 3, expected_version: null })).status, 400);

    const v = app.one('SELECT version FROM users WHERE id = ?', leadId).version;
    assert.equal((await app.call('PATCH', `/api/admin/users/${leadId}`, { is_active: false, version: v }, admin)).status, 200);
    assert.equal((await put(app, lead, 'dep_sales', { score: 3, expected_version: null })).status, 401);
  });

  test('UI contract: /api/auth/me exposes department_ids used by VoteControl to lock foreign columns', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const me = (await app.call('GET', '/api/auth/me', undefined, lead)).body.user;
    assert.deepEqual(me.department_ids, ['dep_sales']);
    assert.equal(me.role, 'department_lead');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PASSWORD, setup } from './helpers';

describe('guest access (public mode)', () => {
  test('guests read published data only, without private fields', async () => {
    const app = await setup();
    const list = await app.call('GET', '/api/features');
    assert.equal(list.status, 200);
    const keys = list.body.features.map((f: any) => f.key);
    assert.ok(keys.includes('RF-1'));
    assert.ok(!keys.includes('RF-5'), 'internal feature must not be listed');
    assert.ok(!keys.includes('RF-25'), 'draft feature must not be listed');
    const json = JSON.stringify(list.body);
    for (const key of ['private_notes', 'author_name', 'assignee_name', 'external_ref', 'estimates', 'visibility', 'version', 'voted_by']) {
      assert.ok(!json.includes(`"${key}"`), `guest payload contains field ${key}`);
    }
    assert.ok(!json.includes('@rafinad.test'), 'guest payload contains an employee email');
    // internal feature by direct link → 404, not a partial payload
    assert.equal((await app.call('GET', '/api/features/RF-5')).status, 404);
    assert.equal((await app.call('GET', '/api/features/RF-25')).status, 404);
  });

  test('hidden related features are not disclosed', async () => {
    const app = await setup();
    // RF-1 (public) blocks RF-5 (internal)
    const r = await app.call('GET', '/api/features/RF-1');
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('Антифрод-скоринг'), 'title of hidden feature leaked');
    assert.ok(r.body.feature.relations.blocks.some((x: any) => x.hidden === true));
    assert.equal(r.body.feature.comments, undefined, 'comments are internal');
    assert.equal(r.body.feature.history, undefined, 'history is internal');
    // releases and graph: hidden epics / releases / nodes are anonymised
    const rel = await app.call('GET', '/api/releases');
    assert.ok(!JSON.stringify(rel.body).includes('Антифрод 2.0'), 'internal release leaked');
    const g = await app.call('GET', '/api/graph');
    assert.ok(!JSON.stringify(g.body).includes('Антифрод-скоринг'));
    assert.ok(g.body.nodes.some((n: any) => n.hidden));
  });

  test('public aggregates count only published features', async () => {
    const app = await setup();
    const guest = await app.call('GET', '/api/overview');
    const admin = await app.user('a@test.io', 'admin');
    const full = await app.call('GET', '/api/overview', undefined, admin);
    assert.ok(guest.body.kpi.total < full.body.kpi.total);
    assert.equal(guest.body.kpi.total, (await app.call('GET', '/api/features')).body.total);
    assert.equal(guest.body.load, null, 'capacity is not public by default');
    const epics = await app.call('GET', '/api/epics');
    const ep2 = epics.body.epics.find((e: any) => e.key === 'EP-2');
    assert.equal(ep2.hours, undefined, 'estimates hidden from guests by default');
    assert.ok(!JSON.stringify(ep2).includes('Экспорт выплат в 1С'), 'internal child feature leaked');
  });

  test('every write endpoint rejects guests', async () => {
    const app = await setup();
    const writes: [string, string, unknown][] = [
      ['POST', '/api/features', { title: 'x' }],
      ['PATCH', '/api/features/RF-1', { title: 'x', version: 1 }],
      ['PUT', '/api/features/RF-1/estimates', { estimates: {} }],
      ['PUT', '/api/features/RF-1/votes/dep_sales', { score: 5, expected_version: 1 }],
      ['POST', '/api/features/RF-1/relations', { type: 'blocks', target_id: 'RF-2' }],
      ['POST', '/api/features/RF-1/comments', { body: 'x' }],
      ['POST', '/api/features/RF-1/merge', { target_id: 'RF-2', source_version: 1, target_version: 1, confirm: true }],
      ['POST', '/api/epics', { title: 'x' }],
      ['POST', '/api/releases', { name: 'x' }],
      ['POST', '/api/import/sources', { name: 'x', kind: 'csv' }],
      ['POST', '/api/admin/users', { email: 'x@x.io', name: 'x', role: 'admin' }],
      ['PATCH', '/api/admin/dict/departments/dep_sales', { weight: 3, version: 1 }],
    ];
    for (const [m, p, b] of writes) {
      const r = await app.call(m, p, b);
      assert.equal(r.status, 401, `${m} ${p} → ${r.status}`);
    }
    assert.equal(app.one('SELECT COUNT(*) AS n FROM features').n, 26);
  });

  test('cross-origin writes are rejected even with a session', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    const r = await app.call('POST', '/api/features', { title: 'CSRF' }, pm, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });
});

describe('roles', () => {
  test('department lead votes only for own departments and cannot edit cards', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const f = (await app.call('GET', '/api/features/RF-4', undefined, lead)).body.feature;
    const salesVote = f.votes.find((v: any) => v.department_id === 'dep_sales');
    const ok = await app.call('PUT', '/api/features/RF-4/votes/dep_sales', { score: 3, expected_version: salesVote.version }, lead);
    assert.equal(ok.status, 200);
    const other = await app.call('PUT', '/api/features/RF-4/votes/dep_finance', { score: 1, expected_version: 1 }, lead);
    assert.equal(other.status, 403);
    assert.equal((await app.call('PATCH', '/api/features/RF-4', { title: 'Hack', version: 1 }, lead)).status, 403);
    assert.equal((await app.call('PUT', '/api/features/RF-4/estimates', { estimates: { team_backend: 1 } }, lead)).status, 403);
    assert.equal((await app.call('PUT', '/api/releases/rel_2/features', { feature_ids: [], version: 1 }, lead)).status, 403);
    // can comment
    assert.equal((await app.call('POST', '/api/features/RF-4/comments', { body: 'Важно для продаж' }, lead)).status, 201);
  });

  test('product team edits catalog but votes only for its own department', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    assert.equal((await app.call('POST', '/api/features', { title: 'Новая задача' }, pm)).status, 201);
    assert.equal((await app.call('PUT', '/api/features/RF-4/votes/dep_sales', { score: 1, expected_version: 1 }, pm)).status, 403);
    assert.equal((await app.call('POST', '/api/admin/users', { email: 'x@x.io', name: 'x', role: 'admin' }, pm)).status, 403);
  });

  test('admin override of another department vote needs a reason and is flagged', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const noReason = await app.call('PUT', '/api/features/RF-4/votes/dep_finance', { score: 2, expected_version: 1 }, admin);
    assert.equal(noReason.status, 400);
    const ok = await app.call('PUT', '/api/features/RF-4/votes/dep_finance', { score: 2, expected_version: 1, reason: 'Решение совета директоров' }, admin);
    assert.equal(ok.status, 200);
    const log = app.one(`SELECT * FROM audit_log WHERE entity_type = 'vote' ORDER BY id DESC LIMIT 1`);
    assert.equal(log.is_override, 1);
    assert.equal(log.reason, 'Решение совета директоров');
  });

  test('admin creates a user with access to several departments; invite flow works', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const created = await app.call('POST', '/api/admin/users', { email: 'new.lead@test.io', name: 'Новый Руководитель', role: 'department_lead', department_ids: ['dep_sales', 'dep_support'], delivery: 'invite' }, admin);
    assert.equal(created.status, 201);
    const token = created.body.invite_url.split('/invite/')[1];
    assert.equal((await app.call('POST', '/api/auth/login', { email: 'new.lead@test.io', password: PASSWORD })).status, 401);
    const accepted = await app.call('POST', '/api/auth/accept-invite', { token, password: 'Strong-pass-2026' });
    assert.equal(accepted.status, 200);
    assert.equal((await app.call('POST', '/api/auth/accept-invite', { token, password: 'Strong-pass-2027' })).status, 400, 'invite is single-use');
    const me = await app.call('GET', '/api/auth/me', undefined, accepted.cookie);
    assert.deepEqual(me.body.user.department_ids.sort(), ['dep_sales', 'dep_support']);
    assert.equal((await app.call('PUT', '/api/features/RF-6/votes/dep_support', { score: 5, expected_version: 1 }, accepted.cookie)).status, 200);
  });

  test('temporary password must be changed before any write', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const created = await app.call('POST', '/api/admin/users', { email: 'pm2@test.io', name: 'PM', role: 'product', delivery: 'temp_password' }, admin);
    const cookie = await app.login('pm2@test.io', created.body.temp_password);
    assert.equal((await app.call('POST', '/api/features', { title: 'x' }, cookie)).status, 403);
    assert.equal((await app.call('POST', '/api/auth/change-password', { current_password: created.body.temp_password, new_password: 'short' }, cookie)).status, 400);
    assert.equal((await app.call('POST', '/api/auth/change-password', { current_password: created.body.temp_password, new_password: 'New-strong-pass-1' }, cookie)).status, 200);
    assert.equal((await app.call('POST', '/api/features', { title: 'x' }, cookie)).status, 201);
  });

  test('the last administrator cannot be removed or disabled', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const me = (await app.call('GET', '/api/admin/users', undefined, admin)).body.users.find((u: any) => u.email === 'admin@test.io');
    const r1 = await app.call('PATCH', `/api/admin/users/${me.id}`, { role: 'product', version: me.version }, admin);
    assert.equal(r1.status, 409);
    const r2 = await app.call('PATCH', `/api/admin/users/${me.id}`, { is_active: false, version: me.version }, admin);
    assert.equal(r2.status, 409);
    assert.equal(app.one('SELECT role_code, is_active FROM users WHERE id = ?', me.id).role_code, 'admin');
    // with a second admin it works
    await app.user('admin2@test.io', 'admin');
    assert.equal((await app.call('PATCH', `/api/admin/users/${me.id}`, { role: 'product', version: me.version }, admin)).status, 200);
  });

  test('disabled users lose their sessions; logout works', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const u = (await app.call('GET', '/api/admin/users', undefined, admin)).body.users.find((x: any) => x.email === 'lead@test.io');
    assert.equal((await app.call('PATCH', `/api/admin/users/${u.id}`, { is_active: false, version: u.version }, admin)).status, 200);
    assert.equal((await app.call('GET', '/api/auth/me', undefined, lead)).body.user, null);
    assert.equal((await app.call('POST', '/api/auth/login', { email: 'lead@test.io', password: PASSWORD })).status, 401);
    await app.call('POST', '/api/auth/logout', {}, admin);
    assert.equal((await app.call('GET', '/api/auth/me', undefined, admin)).body.user, null);
  });

  test('login attempts are throttled', async () => {
    const app = await setup();
    await app.user('victim@test.io', 'product');
    for (let i = 0; i < 5; i++) assert.equal((await app.call('POST', '/api/auth/login', { email: 'victim@test.io', password: 'wrong' })).status, 401);
    const locked = await app.call('POST', '/api/auth/login', { email: 'victim@test.io', password: PASSWORD });
    assert.equal(locked.status, 429);
  });

  test('session cookie is HttpOnly, SameSite and Secure by default', async () => {
    const app = await setup();
    await app.user('c@test.io', 'product');
    app.env.COOKIE_SECURE = undefined;
    const { default: worker } = await import('../worker/index');
    const res = await worker.fetch(new Request('https://app.test/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'c@test.io', password: PASSWORD }) }), app.env);
    const c = res.headers.get('set-cookie')!;
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Secure/);
    const row = app.one('SELECT password_hash FROM users WHERE email = ?', 'c@test.io');
    assert.match(row.password_hash, /^pbkdf2-sha256\$/);
  });
});

describe('dictionaries are dynamic', () => {
  test('admin adds a department and a resource team without code changes', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    assert.equal((await app.call('POST', '/api/admin/dict/departments', { code: 'legal', name: 'Юристы', weight: 1 }, admin)).status, 201);
    assert.equal((await app.call('POST', '/api/admin/dict/teams', { code: 'data', name: 'Data Science' }, admin)).status, 201);
    const meta = (await app.call('GET', '/api/meta')).body;
    assert.ok(meta.departments.some((d: any) => d.name === 'Юристы'));
    const team = meta.teams.find((t: any) => t.code === 'data');
    assert.ok(team);
    // usable immediately: estimate hours for the new team and vote for the new department
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    assert.equal((await app.call('PUT', '/api/features/RF-4/estimates', { estimates: { [team.id]: 12 }, versions: {} }, pm)).status, 200);
    const dep = meta.departments.find((d: any) => d.code === 'legal');
    const legal = await app.user('legal@test.io', 'department_lead', [dep.id]);
    assert.equal((await app.call('PUT', `/api/features/RF-4/votes/${dep.id}`, { score: 4, expected_version: null }, legal)).status, 200);
  });
});

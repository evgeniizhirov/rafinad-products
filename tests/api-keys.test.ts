// P07 / FR-01: personal API keys — scope ∩ role, immediate revocation, hashed storage, audit with key id.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup, type TestApp } from './helpers';

async function newKey(app: TestApp, cookie: string, scopes: string[], extra: Record<string, unknown> = {}) {
  const r = await app.call('POST', '/api/me/api-keys', { name: 'Claude Code', scopes, ...extra }, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.key.id as string, token: r.body.token as string };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const callK = (app: TestApp, method: string, path: string, token: string, body?: unknown) => app.call(method, path, body, null, bearer(token));

describe('API keys', () => {
  test('token is shown once and stored only as a hash; list never returns it', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const { id, token } = await newKey(app, pm, ['tasks:read']);
    assert.match(token, /^rr_[a-z0-9]{8}_[A-Za-z0-9]{40}$/);
    const row = app.one('SELECT * FROM api_keys WHERE id = ?', id);
    assert.ok(!JSON.stringify(row).includes(token.split('_')[2]), 'secret part is not stored');
    assert.equal(row.secret_hash.length, 64);
    const list = await app.call('GET', '/api/me/api-keys', undefined, pm);
    assert.ok(!JSON.stringify(list.body).includes(token.split('_')[2]));
    assert.equal(list.body.keys[0].prefix, `rr_${token.split('_')[1]}_…`);
    // keys cannot manage keys
    assert.equal((await callK(app, 'GET', '/api/me/api-keys', token)).status, 403);
  });

  test('effective rights = role ∩ scope (FR-01 criteria)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const pmCreate = await newKey(app, pm, ['tasks:read', 'tasks:create']);
    const pmRead = await newKey(app, pm, ['tasks:read']);
    const leadAll = await newKey(app, lead, ['tasks:read', 'tasks:create', 'tasks:update', 'priorities:write-own']);
    const created = await callK(app, 'POST', '/api/features', pmCreate.token, { title: 'Создано агентом', initiator: { type: 'department', department_id: 'dep_sales' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await callK(app, 'POST', '/api/features', pmRead.token, { title: 'x' })).status, 403, 'no scope');
    assert.equal((await callK(app, 'POST', '/api/features', leadAll.token, { title: 'x' })).status, 403, 'scope but no role');
    // author = key owner, initiator = what the agent specified (T18)
    const f = app.one('SELECT * FROM features WHERE id = ?', created.body.id);
    assert.equal(f.created_by, app.one("SELECT id FROM users WHERE email = 'pm@test.io'").id);
    assert.equal(f.initiator_department_id, 'dep_sales');
    const log = app.one("SELECT * FROM audit_log WHERE entity_id = ? AND action = 'created'", f.id);
    assert.equal(log.api_key_id, pmCreate.id, 'audit records the key, never the token');
    // reading works; admin-only and import routes are closed to keys even for an admin
    assert.equal((await callK(app, 'GET', '/api/features', pmRead.token)).status, 200);
    const admin = await app.user('admin@test.io', 'admin');
    const adminKey = await newKey(app, admin, ['tasks:read', 'tasks:update', 'priorities:write-own']);
    assert.equal((await callK(app, 'GET', '/api/admin/users', adminKey.token)).status, 403);
    assert.equal((await callK(app, 'GET', '/api/import/sources', adminKey.token)).status, 403);
    // admin key cannot override another department vote even with a reason
    const v = (await callK(app, 'GET', '/api/features/RF-4', adminKey.token)).body.feature.votes.find((x: any) => x.department_id === 'dep_finance')?.version ?? null;
    assert.equal((await callK(app, 'PUT', '/api/features/RF-4/votes/dep_finance', adminKey.token, { score: 1, expected_version: v, reason: 'агент' })).status, 403);
    assert.equal((await callK(app, 'GET', '/api/auth/me', pmRead.token)).body.user.api_key.scopes[0], 'tasks:read');
  });

  test('votes: only own departments, membership re-read on every request (T20)', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const k = await newKey(app, lead, ['tasks:read', 'priorities:write-own']);
    const ver = async (d: string) => (await callK(app, 'GET', '/api/features/RF-4', k.token)).body.feature.votes.find((x: any) => x.department_id === d)?.version ?? null;
    assert.equal((await callK(app, 'PUT', '/api/features/RF-4/votes/dep_sales', k.token, { score: 4, expected_version: await ver('dep_sales') })).status, 200);
    assert.equal((await callK(app, 'PUT', '/api/features/RF-4/votes/dep_finance', k.token, { score: 4, expected_version: await ver('dep_finance') })).status, 403);
    const leadId = app.one("SELECT id FROM users WHERE email = 'lead@test.io'").id;
    const uv = app.one('SELECT version FROM users WHERE id = ?', leadId).version;
    await app.call('PATCH', `/api/admin/users/${leadId}`, { department_ids: [], version: uv }, admin);
    assert.equal((await callK(app, 'PUT', '/api/features/RF-4/votes/dep_sales', k.token, { score: 5, expected_version: await ver('dep_sales') })).status, 403);
  });

  test('revoked, expired, disabled owner, malformed and unknown keys are rejected immediately', async () => {
    const app = await setup();
    const admin = await app.user('admin@test.io', 'admin');
    const pm = await app.user('pm@test.io', 'product');
    const k1 = await newKey(app, pm, ['tasks:read']);
    assert.equal((await callK(app, 'GET', '/api/features', k1.token)).status, 200);
    assert.equal((await app.call('DELETE', `/api/me/api-keys/${k1.id}`, undefined, pm)).status, 200);
    assert.equal((await callK(app, 'GET', '/api/features', k1.token)).status, 401);

    const k2 = await newKey(app, pm, ['tasks:read']);
    app.many("UPDATE api_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ? RETURNING 1", k2.id);
    assert.equal((await callK(app, 'GET', '/api/features', k2.token)).status, 401);

    const k3 = await newKey(app, pm, ['tasks:read']);
    assert.equal((await app.call('POST', `/api/admin/api-keys/${k3.id}/revoke`, { reason: 'утечка' }, admin)).status, 200);
    assert.equal((await callK(app, 'GET', '/api/features', k3.token)).status, 401);

    const k4 = await newKey(app, pm, ['tasks:read']);
    const pmId = app.one("SELECT id FROM users WHERE email = 'pm@test.io'").id;
    app.many('UPDATE users SET is_active = 0 WHERE id = ? RETURNING 1', pmId);
    assert.equal((await callK(app, 'GET', '/api/features', k4.token)).status, 401);

    assert.equal((await callK(app, 'GET', '/api/features', `${k4.token.slice(0, -1)}X`)).status, 401, 'wrong secret');
    assert.equal((await app.call('GET', '/api/features', undefined, null, { authorization: 'Bearer nonsense' })).status, 401);
    assert.equal((await app.call('GET', '/api/features', undefined, null, { authorization: 'Basic abc' })).status, 401);
  });

  test('hidden Product tasks follow the owner role; guests and leads see nothing (T03)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const hidden = (await app.call('POST', '/api/features', { title: 'Секрет для ключа', is_product_internal: true }, pm)).body;
    const lk = await newKey(app, lead, ['tasks:read']);
    assert.equal((await callK(app, 'GET', `/api/features/${hidden.id}`, lk.token)).status, 404);
    assert.ok(!JSON.stringify((await callK(app, 'GET', '/api/features?internal=all', lk.token)).body).includes('Секрет для ключа'));
    const pk = await newKey(app, pm, ['tasks:read']);
    assert.equal((await callK(app, 'GET', `/api/features/${hidden.id}`, pk.token)).status, 200);
  });

  test('rate limit: 429 after 120 requests a minute', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const k = await newKey(app, pm, ['tasks:read']);
    app.many("UPDATE api_keys SET window_start = ?, window_count = 120 WHERE id = ? RETURNING 1", new Date().toISOString(), k.id);
    assert.equal((await callK(app, 'GET', '/api/meta', k.token)).status, 429);
    app.many("UPDATE api_keys SET window_start = '2000-01-01T00:00:00.000Z' WHERE id = ? RETURNING 1", k.id);
    assert.equal((await callK(app, 'GET', '/api/meta', k.token)).status, 200);
  });

  test('cookie login keeps working unchanged', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    assert.equal((await app.call('POST', '/api/features', { title: 'Из браузера' }, pm)).status, 201);
  });
});

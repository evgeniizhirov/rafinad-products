import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from '../../tests/helpers';
import { harness } from './helpers';
import type { Fetch } from '../src/roadmap';

async function local(role: 'product' | 'department_lead' = 'product', scopes = ['tasks:read', 'tasks:create', 'tasks:update', 'priorities:write-own']) {
  const app = await setup();
  const cookie = await app.user('mcp@test.io', role, ['dep_sales']);
  const issued = await app.call('POST', '/api/me/api-keys', { name: 'Local MCP test only', scopes }, cookie);
  assert.equal(issued.status, 201);
  const requests: { path: string; method: string; body: any }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: u.pathname, method: init?.method ?? 'GET', body });
    return app.raw(init?.method ?? 'GET', u.pathname + u.search, body, null, { authorization: new Headers(init?.headers).get('authorization')! });
  };
  const h = await harness(fetcher, { RAFINAD_API_KEY: issued.body.token });
  return { app, cookie, issued, requests, ...h };
}

test('all read tools use actual local Roadmap routes, schemas and ACL', async () => {
  const h = await local();
  try {
    for (const [tool, args] of [
      ['get_my_profile', {}], ['get_reference_data', {}], ['search_tasks', { q: 'RF-4' }],
      ['get_task', { id: 'RF-4' }], ['get_sprints', {}], ['get_current_sprint', { hide_closed: true }],
      ['get_releases', {}], ['get_overview', {}], ['get_analytics', { from: '2026-09-14', to: '2026-10-13' }],
    ] as const) {
      const result = await h.call(tool, args);
      assert.ok(!result.isError, `${tool}: ${JSON.stringify(result.value)}`);
    }
    assert.equal((await h.call('get_my_profile')).value.user.email, 'mcp@test.io');
  } finally { h.app.db.raw.close(); }
});

test('create, update, own vote and comment preserve author, initiator, versions and known fields', async () => {
  const h = await local();
  try {
    const created = await h.call('create_task', { fields: { title: 'MCP local only', initiator: { type: 'department', department_id: 'dep_sales' } }, confirmed: true });
    assert.ok(!created.isError, JSON.stringify(created.value));
    const id = created.value.key;
    const task = (await h.call('get_task', { id })).value.feature;
    assert.equal(h.app.one('SELECT initiator_department_id FROM features WHERE id = ?', created.value.id).initiator_department_id, 'dep_sales');
    assert.equal(h.requests.find(r => r.method === 'POST' && r.path === '/api/features')!.body.assignee_name, undefined);
    assert.equal(h.app.one('SELECT author_name FROM features WHERE id = ?', created.value.id).author_name, 'mcp');
    const update = await h.call('update_task', { id, version: task.version, changes: { description: 'Updated locally' }, confirmed: true });
    assert.ok(!update.isError, JSON.stringify(update.value));
    const now = (await h.call('get_task', { id })).value.feature;
    assert.equal(now.version, task.version + 1);
    const vote = await h.call('set_task_priority', { id, version: now.version, department_id: 'dep_sales', score: 4, expected_version: null, confirmed: true });
    assert.ok(!vote.isError, JSON.stringify(vote.value));
    const comment = await h.call('add_task_comment', { id, version: now.version, body: 'Local comment', confirmed: true });
    assert.ok(!comment.isError, JSON.stringify(comment.value));
    const stale = await h.call('update_task', { id, version: task.version, changes: { title: 'stale' }, confirmed: true });
    assert.equal(stale.value.code, 'version_conflict');
  } finally { h.app.db.raw.close(); }
});

test('revoked key, insufficient scopes, hidden tasks and foreign votes remain inaccessible', async () => {
  const h = await local('department_lead', ['tasks:read', 'tasks:create', 'tasks:update', 'priorities:write-own']);
  try {
    const task = (await h.call('get_task', { id: 'RF-4' })).value.feature;
    assert.equal((await h.call('create_task', { fields: { title: 'forbidden' }, confirmed: true })).value.status, 403);
    assert.equal((await h.call('set_task_priority', { id: 'RF-4', version: task.version, department_id: 'dep_finance', score: 4, expected_version: null, confirmed: true })).value.status, 403);
    h.app.db.raw.prepare('UPDATE features SET is_product_internal = 1 WHERE number = 4').run();
    assert.equal((await h.call('get_task', { id: 'RF-4' })).value.status, 404);
    assert.equal((await h.call('search_tasks', { q: 'RF-4', internal: 'all' })).value.total, 0);
    const revoked = await h.app.call('DELETE', `/api/me/api-keys/${h.issued.body.key.id}`, undefined, h.cookie);
    assert.equal(revoked.status, 200);
    assert.equal((await h.call('get_my_profile')).value.status, 401);
  } finally { h.app.db.raw.close(); }
  const read = await local('product', ['tasks:read']);
  try { assert.equal((await read.call('create_task', { fields: { title: 'forbidden' }, confirmed: true })).value.status, 403); }
  finally { read.app.db.raw.close(); }
});

test('schedule verifies a real sprint then uses task version; missing sprint prevents PATCH', async () => {
  const h = await local();
  try {
    // The calendar generator is invoked only in this isolated SQLite fixture, never through MCP.
    const preview = await h.app.call('POST', '/api/calendar/generate-preview', { releases_ahead: 2, months_ahead: 2 }, h.cookie);
    assert.equal(preview.status, 200);
    const generated = await h.app.call('POST', '/api/calendar/generate', { releases_ahead: 2, months_ahead: 2, plan_hash: preview.body.plan_hash }, h.cookie);
    assert.equal(generated.status, 200);
    const sprint = (await h.call('get_sprints')).value.sprints[0];
    const made = (await h.call('create_task', { fields: { title: 'Schedule local' }, confirmed: true })).value;
    const task = (await h.call('get_task', { id: made.key })).value.feature;
    const moved = await h.call('schedule_task', { id: made.key, version: task.version, sprint_id: sprint.id, confirmed: true });
    assert.ok(!moved.isError, JSON.stringify(moved.value));
    assert.equal((await h.call('get_task', { id: made.key })).value.feature.sprint.id, sprint.id);
    const before = h.requests.filter(r => r.method === 'PATCH').length;
    const missing = await h.call('schedule_task', { id: made.key, version: moved.value.version, sprint_id: 'missing', confirmed: true });
    assert.equal(missing.value.status, 404);
    assert.equal(h.requests.filter(r => r.method === 'PATCH').length, before);
  } finally { h.app.db.raw.close(); }
});

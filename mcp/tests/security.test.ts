import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/index';
import { env, keys, token, harness } from './helpers';
import { Roadmap } from '../src/roadmap';

test('OAuth rejects missing, forged, expired, wrong issuer/audience/client/owner/scope tokens on every method', async () => {
  let fetched = 0;
  const fetcher = async () => { fetched++; return Response.json({}); };
  const invalid = [undefined, 'forged', await token({ exp: 1 }), await token({ iss: 'https://evil.test' }), await token({ aud: 'other' }), await token({ sub: 'other' }), await token({ client_id: 'other' }), await token({ scope: '' }), await token({ exp: Math.floor(Date.now() / 1000) + 3600 })];
  for (const t of invalid) for (const method of ['GET', 'POST', 'DELETE']) {
    const res = await handle(new Request(env.MCP_RESOURCE, { method, headers: t ? { authorization: `Bearer ${t}` } : {} }), env, { keys, fetcher });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
    assert.ok(!(await res.text()).includes(env.RAFINAD_API_KEY));
  }
  assert.equal(fetched, 0);
});

test('discovery, missing configuration, host and origin protection', async () => {
  const metadata = await handle(new Request('https://mcp.test/.well-known/oauth-protected-resource/mcp'), env);
  assert.equal((await metadata.json() as any).resource, env.MCP_RESOURCE);
  assert.equal((await handle(new Request(env.MCP_RESOURCE), { ...env, OWNER_SUBJECT: '' })).status, 503);
  assert.equal((await handle(new Request('https://evil.test/mcp'), env)).status, 403);
  assert.equal((await handle(new Request(env.MCP_RESOURCE, { headers: { origin: 'https://evil.test' } }), env)).status, 403);
});

test('MCP initialize and real tools/list; read-only switch AND OAuth scope hide all writes', async () => {
  for (const [settings, claims, count] of [[{}, {}, 14], [{ ENABLE_WRITES: 'false' }, {}, 9], [{}, { scope: 'roadmap:read' }, 9]] as const) {
    const h = await harness(async () => Response.json({}), settings, claims);
    const init = await h.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'tests', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'rafinad-roadmap');
    const list = await h.rpc('tools/list');
    assert.equal(list.result.tools.length, count);
    assert.ok(list.result.tools.every((t: any) => typeof t.annotations.readOnlyHint === 'boolean'));
    if (count === 9) assert.ok((await h.call('create_task', { fields: { title: 'x' }, confirmed: true })).isError);
  }
});

test('unknown fields, URL IDs and missing confirmation never reach REST', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return Response.json({}); });
  for (const [name, args] of [
    ['get_task', { id: 'https://evil.test/' }], ['get_task', { id: '..' }],
    ['search_tasks', { url: 'https://evil.test/' }],
    ['search_tasks', { offer: 'retired' }], ['search_tasks', { period: 'retired' }],
    ['create_task', { fields: { title: 'x', offer_ids: ['retired'] }, confirmed: true }],
    ['create_task', { fields: { title: 'x' } }],
    ['create_task', { fields: { title: 'x', author_name: 'spoof' }, confirmed: true }],
  ] as const) assert.ok((await h.call(name, args)).isError);
  assert.equal(calls, 0);
});

test('REST errors never leak raw bodies/secrets and create is never retried', async () => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    let calls = 0;
    const h = await harness(async () => { calls++; return Response.json({ error: { code: 'private', message: env.RAFINAD_API_KEY } }, { status }); });
    const result = await h.call('create_task', { fields: { title: 'x' }, confirmed: true });
    assert.equal(result.isError, true);
    assert.equal(result.value.status, status);
    assert.ok(!JSON.stringify(result).includes(env.RAFINAD_API_KEY));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const h = await harness(async () => { calls++; throw new Error(env.RAFINAD_API_KEY); });
  assert.equal((await h.call('create_task', { fields: { title: 'x' }, confirmed: true })).value.code, 'unknown_result');
  assert.equal(calls, 1);
});

test('REST transport fixes origin, disallows redirects and sanitizes successful responses', async () => {
  const api = new Roadmap(env.RAFINAD_API_KEY, async (url, init) => {
    assert.equal(new URL(String(url)).origin, 'https://products-roadmap.ezhirov-es.workers.dev');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${env.RAFINAD_API_KEY}`);
    return Response.json({ title: env.RAFINAD_API_KEY, nested: { authorization: 'secret', note: 'Bearer secret' } });
  });
  assert.deepEqual(await api.task('RF-1'), { title: '[REDACTED]', nested: { note: 'Bearer [REDACTED]' } });
});

test('stale task version stops writes; 409 rereads state and requires new confirmation', async () => {
  for (const stale of [true, false]) {
    const methods: string[] = [];
    const h = await harness(async (_url, init) => {
      methods.push(init!.method!);
      return init!.method === 'GET' ? Response.json({ feature: { version: stale ? 2 : 1 } }) : Response.json({ error: { code: 'version_conflict' } }, { status: 409 });
    });
    const result = await h.call('update_task', { id: 'RF-1', version: 1, changes: { title: 'new' }, confirmed: true });
    assert.equal(result.value.code, 'version_conflict');
    assert.equal(result.value.requires_new_confirmation, true);
    assert.ok(result.value.current.feature);
    assert.deepEqual(methods, stale ? ['GET', 'GET'] : ['GET', 'PATCH', 'GET']);
  }
});

test('vote has its own version; stale vote and foreign department never write', async () => {
  let writes = 0;
  const h = await harness(async (url, init) => {
    if (init?.method !== 'GET') writes++;
    return Response.json(String(url).endsWith('/auth/me')
      ? { user: { department_ids: ['dep_sales'] } }
      : { feature: { version: 1, votes: [{ department_id: 'dep_sales', version: 2 }] } });
  });
  const base = { id: 'RF-1', version: 1, score: 4, expected_version: 1, confirmed: true };
  assert.equal((await h.call('set_task_priority', { ...base, department_id: 'dep_sales' })).value.code, 'version_conflict');
  assert.equal((await h.call('set_task_priority', { ...base, department_id: 'dep_other' })).value.status, 403);
  assert.equal(writes, 0);
});

test('calendar chooses current sprint from backend and forwards closed-task filter', async () => {
  const paths: string[] = [];
  const h = await harness(async url => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    paths.push(path);
    if (path === '/api/calendar') return Response.json({ today: '2026-10-13', current_sprint_id: 'spr_current' });
    if (path.startsWith('/api/sprints/')) return Response.json({ sprint: { id: 'spr_current' } });
    return Response.json({ features: [{ key: 'RF-1' }], total: 1 });
  });
  const result = await h.call('get_current_sprint', { hide_closed: true });
  assert.equal(result.value.features[0].key, 'RF-1');
  assert.deepEqual(paths, ['/api/calendar', '/api/sprints/spr_current', '/api/features?sprint=spr_current&hide_closed=1']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers';

test('smoke: public endpoints respond for guests', async () => {
  const app = await setup();
  for (const path of ['/api/meta', '/api/features', '/api/epics', '/api/offers', '/api/priorities', '/api/roadmap', '/api/releases', '/api/overview', '/api/graph']) {
    const r = await app.call('GET', path);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
});

test('smoke: employee endpoints respond', async () => {
  const app = await setup();
  const admin = await app.user('admin@test.io', 'admin', ['dep_product']);
  for (const path of ['/api/auth/me', '/api/planning', '/api/import/sources', '/api/import/runs', '/api/admin/users', '/api/admin/audit', '/api/features/RF-1', '/api/features/1/merge-preview?target_id=RF-2']) {
    const r = await app.call('GET', path, undefined, admin);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
});

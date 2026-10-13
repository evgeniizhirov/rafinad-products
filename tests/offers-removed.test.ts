// vNext PR 1: the «Офферы» catalog is gone from the API, import and task card; old clients (and the MCP worker,
// whose schema still has offer_ids / ?offer=) keep working without errors.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEMO_SHEETS } from '../worker/demoData';
import { setup } from './helpers';

describe('offers removed', () => {
  test('offer routes answer 410 with a clear message for every role', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    for (const [method, path, cookie] of [['GET', '/api/offers', null], ['GET', '/api/offers', pm], ['GET', '/api/offers/of_2051', pm], ['POST', '/api/offers', pm], ['PATCH', '/api/offers/of_2051', pm]] as const) {
      const r = await app.call(method, path, method === 'GET' ? undefined : { name: 'x' }, cookie);
      assert.equal(r.status, 410, `${method} ${path}`);
      assert.equal(r.body.error.code, 'gone');
      assert.match(r.body.error.message, /Предложения/);
    }
  });

  test('offer_ids from old clients are accepted and ignored; ?offer= gives an empty list, not an error', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const c = await app.call('POST', '/api/features', { title: 'Со старым клиентом', offer_ids: ['of_2051'] }, pm);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const v = app.one('SELECT version FROM features WHERE id = ?', c.body.id).version;
    assert.equal((await app.call('PATCH', `/api/features/${c.body.id}`, { offer_ids: [], title: 'Переименована', version: v }, pm)).status, 200);
    const card = (await app.call('GET', `/api/features/${c.body.id}`, undefined, pm)).body.feature;
    assert.equal(card.offers, undefined);
    const list = await app.call('GET', '/api/features?offer=of_2051', undefined, pm);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 0);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM feature_offers').n, 0, 'nothing is written to the old link table');
  });

  test('import: the template has no Offers sheet; an old affects_offer relation is a clear row error, not a crash', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    assert.ok(!('offers' in DEMO_SHEETS));
    assert.equal((await app.call('GET', '/api/import/template/offers.csv', undefined, pm)).status, 404);
    const s = await app.call('POST', '/api/import/sources', { name: 'Старый шаблон', kind: 'csv' }, pm);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const src = (await app.call('GET', '/api/import/sources', undefined, pm)).body.sources.find((x: any) => x.id === s.body.id);
    const relations = 'from_type,from_external_id,relation_type,to_type,to_external_id\r\nfeature,RAF-412,affects_offer,offer,OF-2051';
    const up = await app.call('PUT', `/api/import/sources/${src.id}/csv`, { sheets: { relations, offers: 'external_id,name\r\nOF-1,x' }, version: src.version }, pm);
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const run = (await app.call('POST', `/api/import/sources/${src.id}/preview`, {}, pm)).body.run;
    assert.ok(!run.items.some((i: any) => i.entity_type === 'offer'), 'an Offers sheet is not read');
    const rel = run.items.find((i: any) => i.entity_type === 'relation');
    assert.equal(rel.action, 'error');
    assert.match(rel.errors.join(' '), /Офферы/);
  });
});

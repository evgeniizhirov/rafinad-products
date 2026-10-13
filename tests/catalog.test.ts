import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setup } from './helpers';

describe('catalog', () => {
  test('feature is created manually, put into an epic, linked to features (offer_ids from old clients are ignored)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    const c = await app.call('POST', '/api/features', {
      title: 'Вебхуки для рекламодателей', description: 'Описание', epic_id: 'ep_4', category_id: 'cat_advertisers', offer_ids: ['of_2051', 'of_3001'],
      tags: ['api'], estimates: { team_backend: 30, team_qa: 8 }, visibility: 'public',
    }, pm);
    assert.equal(c.status, 201);
    assert.equal(c.body.key, 'RF-27');
    const rel = await app.call('POST', `/api/features/${c.body.id}/relations`, { type: 'blocked_by', target_id: 'RF-12' }, pm);
    assert.equal(rel.status, 201);
    assert.equal((await app.call('POST', `/api/features/${c.body.id}/relations`, { type: 'related_to', target_id: 'RF-4' }, pm)).status, 201);
    const f = (await app.call('GET', '/api/features/RF-27', undefined, pm)).body.feature;
    assert.equal(f.epic.id, 'ep_4');
    assert.equal(f.offers, undefined, 'offers are gone from the task card');
    assert.equal(f.relations.blocked_by[0].key, 'RF-12');
    assert.equal(f.relations.related[0].key, 'RF-4');
    assert.deepEqual(f.estimates, { team_backend: 30, team_qa: 8 });
    assert.ok(f.estimate_missing.includes('team_frontend'), 'teams without an estimate are "not estimated", not zero');
    // epic tree aggregates hours from features
    const epic = (await app.call('GET', '/api/epics/ep_4', undefined, pm)).body.epic;
    assert.ok(epic.features.some((x: any) => x.key === 'RF-27'));
    assert.ok(epic.total_hours >= 38);
  });

  test('cyclic blocking is rejected', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    // seed: RF-1 blocks RF-5, RF-17 blocks RF-5
    const r = await app.call('POST', '/api/features/RF-5/relations', { type: 'blocks', target_id: 'RF-1' }, pm);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'cycle');
    assert.match(r.body.error.message, /RF-5 → RF-1 → RF-5/);
    // longer cycle: RF-7 → RF-8 exists; add RF-8 → RF-6, then RF-6 → RF-7 must fail
    assert.equal((await app.call('POST', '/api/features/RF-8/relations', { type: 'blocks', target_id: 'RF-6' }, pm)).status, 201);
    assert.equal((await app.call('POST', '/api/features/RF-6/relations', { type: 'blocks', target_id: 'RF-7' }, pm)).status, 409);
    assert.equal((await app.call('POST', '/api/features/RF-6/relations', { type: 'blocks', target_id: 'RF-6' }, pm)).status, 400);
  });

  test('concurrent edits: the later save does not silently overwrite (optimistic locking)', async () => {
    const app = await setup();
    const pm1 = await app.user('pm1@test.io', 'product');
    const pm2 = await app.user('pm2@test.io', 'product');
    const f = (await app.call('GET', '/api/features/RF-4', undefined, pm1)).body.feature;
    const a = await app.call('PATCH', '/api/features/RF-4', { title: 'Версия первого', version: f.version }, pm1);
    assert.equal(a.status, 200);
    const b = await app.call('PATCH', '/api/features/RF-4', { title: 'Версия второго', version: f.version }, pm2);
    assert.equal(b.status, 409);
    assert.equal(b.body.error.code, 'version_conflict');
    assert.equal(app.one('SELECT title FROM features WHERE number = 4').title, 'Версия первого');
    // estimates: stale version → conflict
    const est = (await app.call('PUT', '/api/features/RF-4/estimates', { estimates: { team_backend: 100 }, versions: { team_backend: 1 } }, pm1));
    assert.equal(est.status, 200);
    const est2 = (await app.call('PUT', '/api/features/RF-4/estimates', { estimates: { team_backend: 90 }, versions: { team_backend: 1 } }, pm2));
    assert.equal(est2.status, 409);
    // release composition
    const rel = (await app.call('GET', '/api/releases/rel_2', undefined, pm1)).body.release;
    assert.equal((await app.call('PUT', '/api/releases/rel_2/features', { feature_ids: [...rel.feature_ids, 'feat_008'], version: rel.version }, pm1)).status, 200);
    assert.equal((await app.call('PUT', '/api/releases/rel_2/features', { feature_ids: rel.feature_ids, version: rel.version }, pm2)).status, 409);
  });

  test('department vote: single current score, competing changes are rejected and logged', async () => {
    const app = await setup();
    const a = await app.user('lead1@test.io', 'department_lead', ['dep_finance']);
    const b = await app.user('lead2@test.io', 'department_lead', ['dep_finance']);
    // RF-6 has no finance vote yet
    assert.equal((await app.call('PUT', '/api/features/RF-6/votes/dep_finance', { score: 4, expected_version: null }, a)).status, 200);
    const late = await app.call('PUT', '/api/features/RF-6/votes/dep_finance', { score: 1, expected_version: null }, b);
    assert.equal(late.status, 409);
    assert.equal(late.body.error.details.current.score, 4);
    assert.equal((await app.call('PUT', '/api/features/RF-6/votes/dep_finance', { score: 2, expected_version: 1 }, b)).status, 200);
    const rows = app.many(`SELECT * FROM department_votes WHERE feature_id = 'feat_006' AND department_id = 'dep_finance'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].score, 2);
    const hist = app.many(`SELECT changes FROM audit_log WHERE entity_type = 'vote' AND entity_id = 'feat_006' ORDER BY id`);
    assert.equal(hist.length, 2);
    assert.deepEqual(JSON.parse(hist[1].changes)[0], { field: 'vote:Финансы', old: 4, new: 2 });
  });

  test('vote changes the ranking immediately but never an approved release', async () => {
    const app = await setup();
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales', 'dep_affiliates', 'dep_finance', 'dep_support', 'dep_antifraud', 'dep_product']);
    const before = (await app.call('GET', '/api/priorities')).body.features.map((f: any) => f.key);
    const releaseBefore = app.many(`SELECT feature_id FROM release_features WHERE release_id = 'rel_1' ORDER BY feature_id`);
    const f23 = (await app.call('GET', '/api/features/RF-23', undefined, lead)).body.feature;
    assert.equal(f23.priority.score, null);
    for (const d of ['dep_sales', 'dep_affiliates', 'dep_finance', 'dep_support', 'dep_antifraud', 'dep_product']) {
      assert.equal((await app.call('PUT', `/api/features/RF-23/votes/${d}`, { score: 5, expected_version: null }, lead)).status, 200);
    }
    const after = (await app.call('GET', '/api/priorities')).body.features.map((f: any) => f.key);
    assert.notDeepEqual(before, after);
    assert.equal(after[0], 'RF-23');
    assert.deepEqual(app.many(`SELECT feature_id FROM release_features WHERE release_id = 'rel_1' ORDER BY feature_id`), releaseBefore);
    assert.ok(app.one(`SELECT approved_at FROM releases WHERE id = 'rel_1'`).approved_at);
  });

  test('status → done sets the completion date; reopening keeps history', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    let f = (await app.call('GET', '/api/features/RF-6', undefined, pm)).body.feature;
    assert.equal((await app.call('PATCH', '/api/features/RF-6', { status_id: 'st_f_done', version: f.version }, pm)).status, 200);
    f = (await app.call('GET', '/api/features/RF-6', undefined, pm)).body.feature;
    assert.ok(f.closed_at);
    assert.equal((await app.call('PATCH', '/api/features/RF-6', { status_id: 'st_f_progress', version: f.version }, pm)).status, 200);
    f = (await app.call('GET', '/api/features/RF-6', undefined, pm)).body.feature;
    assert.equal(f.closed_at, null);
    const statusChanges = f.history.filter((h: any) => h.changes?.some((c: any) => c.field === 'status_id'));
    assert.equal(statusChanges.length, 2);
    assert.ok(f.history.some((h: any) => h.changes?.some((c: any) => c.field === 'closed_at' && c.old)));
  });

  test('merging duplicates keeps sources, comments and history; vote conflicts are explicit', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', ['dep_product']);
    // RF-11 (source) into RF-3 (target): both have affiliates/support/finance votes with different scores
    const preview = (await app.call('GET', '/api/features/RF-11/merge-preview?target_id=RF-3', undefined, pm)).body;
    assert.ok(preview.vote_conflicts.length >= 2);
    const noChoice = await app.call('POST', '/api/features/RF-11/merge', { target_id: 'RF-3', source_version: preview.source.version, target_version: preview.target.version, confirm: true }, pm);
    assert.equal(noChoice.status, 400);
    const choices = Object.fromEntries(preview.vote_conflicts.map((c: any) => [c.department_id, 'target']));
    choices.dep_support = 'source';
    const commentsBefore = app.one(`SELECT COUNT(*) AS n FROM comments WHERE feature_id IN ('feat_003','feat_011')`).n;
    const backendBefore = app.one(`SELECT hours FROM feature_estimates WHERE feature_id = 'feat_003' AND team_id = 'team_backend'`).hours;
    const ok = await app.call('POST', '/api/features/RF-11/merge', { target_id: 'RF-3', source_version: preview.source.version, target_version: preview.target.version, vote_choices: choices, confirm: true }, pm);
    assert.equal(ok.status, 200);
    // old link resolves to the main card
    const old = (await app.call('GET', '/api/features/RF-11', undefined, pm)).body.feature;
    assert.equal(old.key, 'RF-3');
    assert.equal(old.merged_from.key, 'RF-11');
    assert.ok(old.merged_duplicates.some((d: any) => d.key === 'RF-11'));
    // votes: one per department, conflicts resolved as chosen, not summed/averaged
    const votes = app.many(`SELECT department_id, score FROM department_votes WHERE feature_id = 'feat_003'`);
    assert.equal(votes.find((v: any) => v.department_id === 'dep_support').score, 5); // source value chosen
    assert.equal(votes.find((v: any) => v.department_id === 'dep_affiliates').score, 5);
    assert.equal(app.one(`SELECT COUNT(*) AS n FROM department_votes WHERE feature_id = 'feat_011'`).n, 0);
    // hours not double counted
    assert.equal(app.one(`SELECT hours FROM feature_estimates WHERE feature_id = 'feat_003' AND team_id = 'team_backend'`).hours, backendBefore);
    assert.equal(app.one(`SELECT COUNT(*) AS n FROM comments WHERE feature_id = 'feat_003'`).n, commentsBefore);
    // history of both cards available on the main card
    assert.ok(old.history.some((h: any) => h.action === 'merged_into'));
    assert.ok(old.history.some((h: any) => h.action === 'merged_from'));
    // duplicate disappears from lists
    assert.ok(!(await app.call('GET', '/api/features', undefined, pm)).body.features.some((f: any) => f.key === 'RF-11'));
    // the blocks relation RF-3 → RF-11 became a self loop and was dropped (no cycle)
    assert.equal(app.one(`SELECT COUNT(*) AS n FROM feature_relations WHERE type = 'blocks' AND from_id = to_id`).n, 0);
  });

  test('changes persist and the journal shows who and when', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', [], 'Пётр Менеджер');
    const f = (await app.call('GET', '/api/features/RF-7', undefined, pm)).body.feature;
    await app.call('PATCH', '/api/features/RF-7', { title: 'Каталог офферов v2', tags: ['каталог', 'гео'], version: f.version }, pm);
    const again = await app.login('pm@test.io');
    const g = (await app.call('GET', '/api/features/RF-7', undefined, again)).body.feature;
    assert.equal(g.title, 'Каталог офферов v2');
    assert.deepEqual(g.tags.sort(), ['гео', 'каталог']);
    const h = g.history[0];
    assert.equal(h.actor_name, 'Пётр Менеджер');
    assert.ok(h.at);
    assert.ok(h.changes.some((c: any) => c.field === 'title' && c.old === 'Каталог офферов: фильтры по ГЕО и типу трафика'));
  });
});

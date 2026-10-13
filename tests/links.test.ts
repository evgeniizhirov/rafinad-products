// vNext PR 3 (ТЗ §3): external links of a task — validation, several links of one type, rights, history, merge.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkUrl, extractUrls, guessKind } from '../worker/domain/links';
import { setup, type TestApp } from './helpers';

const add = (app: TestApp, cookie: string | null, task: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  app.call('POST', `/api/features/${task}/links`, body, cookie, headers);

describe('link helpers', () => {
  test('only absolute http(s) URLs are accepted; dangerous or broken values get a clear error', () => {
    assert.deepEqual(checkUrl('  https://jira.ly9.ru/browse/XG-3286 '), { ok: true, url: 'https://jira.ly9.ru/browse/XG-3286' });
    assert.ok(checkUrl('http://example.com/a?b=1#c').ok);
    for (const bad of ['javascript:alert(1)', 'ftp://files.example.com/x', 'data:text/html,<b>x</b>', 'jira.ly9.ru/browse/XG-1', 'https://exa mple.com', 'https://user:pass@example.com/', 'https://localhost/x', '']) {
      const r = checkUrl(bad);
      assert.equal(r.ok, false, bad);
      if (!r.ok) assert.ok(r.error.length > 5);
    }
    assert.ok(!checkUrl(`https://example.com/${'a'.repeat(2100)}`).ok);
  });

  test('kind is guessed from the address (Bitrix24 on its own domain is recognised by the path)', () => {
    assert.equal(guessKind('https://jira.ly9.ru/browse/XG-3286'), 'jira');
    assert.equal(guessKind('https://company.atlassian.net/browse/ABC-12'), 'jira');
    assert.equal(guessKind('https://my.kokocgroup.ru/workgroups/group/2669/tasks/task/view/399512/'), 'bitrix24');
    assert.equal(guessKind('https://rafinad.bitrix24.ru/company/personal/user/1/tasks/task/view/5/'), 'bitrix24');
    assert.equal(guessKind('https://confluence.example.com/display/PROD/Spec'), 'docs');
    assert.equal(guessKind('https://docs.google.com/document/d/abc/edit'), 'docs');
    assert.equal(guessKind('https://example.com/'), 'other');
  });

  test('URLs are extracted from free text without trailing punctuation and without duplicates', () => {
    const text = 'См. https://jira.ly9.ru/browse/XG-1, и (https://wiki.example.com/page_(v2)). Ещё раз https://jira.ly9.ru/browse/XG-1. Не ссылка: jira.ly9.ru/x';
    assert.deepEqual(extractUrls(text), ['https://jira.ly9.ru/browse/XG-1', 'https://wiki.example.com/page_(v2)']);
    assert.deepEqual(extractUrls('нет ссылок'), []);
  });
});

describe('task links API', () => {
  test('several links of one type, kind guessed or set, duplicate URL refused, history written', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const jira1 = await add(app, pm, 'RF-1', { url: 'https://jira.ly9.ru/browse/XG-1' });
    assert.equal(jira1.status, 201, JSON.stringify(jira1.body));
    assert.equal(jira1.body.link.kind, 'jira');
    assert.equal(jira1.body.link.origin, 'manual');
    assert.equal((await add(app, pm, 'RF-1', { url: 'https://jira.ly9.ru/browse/XG-2', title: 'Бэкенд' })).status, 201);
    assert.equal((await add(app, pm, 'RF-1', { url: 'https://my.kokocgroup.ru/workgroups/group/2669/tasks/task/view/399512/' })).body.link.kind, 'bitrix24');
    assert.equal((await add(app, pm, 'RF-1', { url: 'https://example.com/spec', kind: 'docs', title: 'Спецификация' })).body.link.kind, 'docs');
    const dup = await add(app, pm, 'RF-1', { url: ' https://jira.ly9.ru/browse/XG-1 ' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'duplicate_link');
    const bad = await add(app, pm, 'RF-1', { url: 'javascript:alert(1)' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /https?:\/\//);
    const card = (await app.call('GET', '/api/features/RF-1', undefined, pm)).body.feature;
    assert.equal(card.links.length, 4);
    assert.equal(card.links.filter((l: any) => l.kind === 'jira').length, 2);
    const hist = (await app.call('GET', '/api/features/RF-1', undefined, pm)).body.feature.history ?? [];
    assert.ok(JSON.stringify(hist).includes('link_added') || app.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'link_added'").n === 4);
  });

  test('edit with optimistic locking; editing an imported link marks it as locally edited; delete', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const l = (await add(app, pm, 'RF-2', { url: 'https://example.com/a' })).body.link;
    const ok = await app.call('PATCH', `/api/links/${l.id}`, { title: 'Макет', kind: 'docs', version: l.version }, pm);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.link.title, 'Макет');
    assert.equal(ok.body.link.locally_edited, false, 'manual links are never "locally edited"');
    assert.equal((await app.call('PATCH', `/api/links/${l.id}`, { title: 'Устаревшая версия', version: l.version }, pm)).status, 409);
    // an imported link
    const f2 = app.one("SELECT id FROM features WHERE number = 2").id;
    app.many(`INSERT INTO feature_links (id, feature_id, kind, url, origin, created_at, updated_at) VALUES ('lnk_imp', ?, 'jira', 'https://jira.ly9.ru/browse/XG-9', 'import', '2026-10-01', '2026-10-01') RETURNING 1`, f2);
    const e = await app.call('PATCH', '/api/links/lnk_imp', { title: 'Переименовано вручную', version: 1 }, pm);
    assert.equal(e.body.link.origin, 'import');
    assert.equal(e.body.link.locally_edited, true);
    assert.equal((await app.call('DELETE', `/api/links/${l.id}`, undefined, pm)).status, 200);
    assert.equal((await app.call('GET', '/api/features/RF-2/links', undefined, pm)).body.links.length, 1);
    assert.ok(app.one("SELECT 1 AS x FROM audit_log WHERE entity_id = ? AND action = 'link_removed'", f2));
  });

  test('rights: employees read, only product/admin write, guests never see links, hidden tasks stay hidden', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    await add(app, pm, 'RF-1', { url: 'https://jira.ly9.ru/browse/XG-1' });
    assert.equal((await add(app, lead, 'RF-1', { url: 'https://example.com/x' })).status, 403);
    assert.equal((await add(app, null, 'RF-1', { url: 'https://example.com/x' })).status, 401);
    assert.equal((await app.call('GET', '/api/features/RF-1', undefined, lead)).body.feature.links.length, 1);
    const guestCard = (await app.call('GET', '/api/features/RF-1')).body.feature;
    assert.equal(guestCard.links, undefined, 'RF-1 is public, but its links are not for guests');
    assert.equal((await app.call('GET', '/api/features/RF-1/links')).status, 401);
    // hidden Product task: its links do not exist for a lead
    const hidden = (await app.call('POST', '/api/features', { title: 'Скрытая', is_product_internal: true }, pm)).body.id;
    const hl = (await add(app, pm, hidden, { url: 'https://example.com/secret' })).body.link;
    assert.equal((await app.call('GET', `/api/features/${hidden}/links`, undefined, lead)).status, 404);
    assert.equal((await app.call('PATCH', `/api/links/${hl.id}`, { title: 'x', version: 1 }, lead)).status, 403);
    assert.ok(!JSON.stringify((await app.call('GET', '/api/features?internal=all', undefined, lead)).body).includes('example.com/secret'));
  });

  test('API key: tasks:update may add links, tasks:read may only read', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const rw = (await app.call('POST', '/api/me/api-keys', { name: 'rw', scopes: ['tasks:read', 'tasks:update'] }, pm)).body.token;
    const ro = (await app.call('POST', '/api/me/api-keys', { name: 'ro', scopes: ['tasks:read'] }, pm)).body.token;
    const created = await add(app, null, 'RF-3', { url: 'https://jira.ly9.ru/browse/XG-3' }, { authorization: `Bearer ${rw}` });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await app.call('DELETE', `/api/links/${created.body.link.id}`, undefined, null, { authorization: `Bearer ${ro}` })).status, 403);
    assert.equal((await app.call('GET', '/api/features/RF-3/links', undefined, null, { authorization: `Bearer ${ro}` })).body.links.length, 1);
    assert.ok(app.one("SELECT api_key_id FROM audit_log WHERE action = 'link_added'").api_key_id);
  });

  test('merging a duplicate moves its links to the main card without duplicating a URL', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const a = (await app.call('POST', '/api/features', { title: 'Основная' }, pm)).body;
    const b = (await app.call('POST', '/api/features', { title: 'Дубль' }, pm)).body;
    await add(app, pm, a.id, { url: 'https://jira.ly9.ru/browse/XG-1' });
    await add(app, pm, b.id, { url: 'https://jira.ly9.ru/browse/XG-1' });
    await add(app, pm, b.id, { url: 'https://example.com/only-on-duplicate' });
    const m = await app.call('POST', `/api/features/${b.id}/merge`, { target_id: a.id, source_version: 1, target_version: 1, confirm: true }, pm);
    assert.equal(m.status, 200, JSON.stringify(m.body));
    const links = (await app.call('GET', `/api/features/${a.id}/links`, undefined, pm)).body.links.map((l: any) => l.url).sort();
    assert.deepEqual(links, ['https://example.com/only-on-duplicate', 'https://jira.ly9.ru/browse/XG-1']);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM feature_links WHERE feature_id = ?', b.id).n, 0);
  });
});

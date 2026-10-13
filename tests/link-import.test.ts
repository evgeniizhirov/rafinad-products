// vNext PR 4 (ТЗ §3 «Импорт ссылок»): link columns → link kinds, several URLs per cell, URLs in text,
// Google hidden hyperlinks, idempotent re-import, manual links untouched, «нет в источнике», conflicts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCsv } from '../worker/domain/csv';
import { BUGS_CONFIG, flatToCanonical } from '../worker/domain/flatSheet';
import { decodeLinks, planLinks, readLinkCell } from '../worker/domain/linkImport';
import { setup, type TestApp } from './helpers';

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
const csv = (rows: string[][]) => rows.map((r) => r.map(q).join(',')).join('\n');

const FLAT = {
  sheet: 'Задачи',
  columns: { title: 'Название', id: 'Ключ', description: 'Описание' },
  links: { 'Jira': 'jira', 'Документация': 'docs' },
  links_from_text: true,
  flags: {}, hours: {},
};
const HEADER = ['Ключ', 'Название', 'Описание', 'Jira', 'Документация'];

async function source(app: TestApp, cookie: string, flat: unknown = FLAT) {
  const r = await app.call('POST', '/api/import/sources', { name: 'Ссылки', kind: 'csv', config: { format: 'flat', flat, newVisibility: 'internal' } }, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}
async function preview(app: TestApp, cookie: string, src: string, rows: string[][]) {
  const s = (await app.call('GET', '/api/import/sources', undefined, cookie)).body.sources.find((x: any) => x.id === src);
  assert.equal((await app.call('PUT', `/api/import/sources/${src}/csv`, { sheets: { flat: csv([HEADER, ...rows]) }, version: s.version }, cookie)).status, 200);
  const pv = await app.call('POST', `/api/import/sources/${src}/preview`, {}, cookie);
  assert.equal(pv.status, 201, JSON.stringify(pv.body));
  return pv.body.run;
}
const apply = async (app: TestApp, cookie: string, run: any) => {
  const a = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, cookie);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return a.body;
};
const item = (run: any, ext: string) => run.items.find((i: any) => i.external_id === ext);
const linksOf = (app: TestApp, ext: string) => app.many(
  `SELECT l.kind, l.url, l.origin, l.locally_edited FROM feature_links l JOIN features f ON f.id = l.feature_id WHERE f.external_ref = ? ORDER BY l.url`, ext,
);

describe('link import: pure parts', () => {
  test('a link cell: several URLs, hidden hyperlinks, duplicates, a non-URL value is reported', () => {
    const r = readLinkCell('XG-1 https://jira.ly9.ru/browse/XG-1, https://jira.ly9.ru/browse/XG-2', ['https://jira.ly9.ru/browse/XG-1', 'https://jira.ly9.ru/browse/XG-3'], 'Jira', 'jira', true);
    assert.deepEqual(r.links.map((l) => l.url), ['https://jira.ly9.ru/browse/XG-1', 'https://jira.ly9.ru/browse/XG-2', 'https://jira.ly9.ru/browse/XG-3']);
    assert.ok(r.links.every((l) => l.kind === 'jira' && l.column === 'Jira'));
    assert.deepEqual(r.problems, []);
    const bad = readLinkCell('см. вики', [], 'Документация', 'docs', true);
    assert.equal(bad.links.length, 0);
    assert.match(bad.problems[0], /^Ссылка не импортирована — колонка «Документация»: «см\. вики» не адрес/);
    assert.deepEqual(readLinkCell('просто текст', [], 'Описание', undefined, false), { links: [], problems: [] }, 'free text without URLs is not an error');
    assert.deepEqual(decodeLinks('jira https://a.example/x\nДокументация: https://b.example/y\nhttps://my.kokocgroup.ru/workgroups/group/1/tasks/task/view/2/').links.map((l) => l.kind), ['jira', 'docs', 'bitrix24']);
  });

  test('plan: add / unchanged / kind change / conflict on a hand-edited link / manual kept / missing', () => {
    const existing = [
      { id: 'm', feature_id: 'f', kind: 'other', url: 'https://manual.example/', origin: 'manual', source_id: null, locally_edited: 0 },
      { id: 'a', feature_id: 'f', kind: 'jira', url: 'https://same.example/', origin: 'import', source_id: 'S', locally_edited: 0 },
      { id: 'b', feature_id: 'f', kind: 'other', url: 'https://kind.example/', origin: 'import', source_id: 'S', locally_edited: 0 },
      { id: 'c', feature_id: 'f', kind: 'other', url: 'https://edited.example/', origin: 'import', source_id: 'S', locally_edited: 1 },
      { id: 'd', feature_id: 'f', kind: 'docs', url: 'https://gone.example/', origin: 'import', source_id: 'S', locally_edited: 0 },
      { id: 'e', feature_id: 'f', kind: 'docs', url: 'https://other-source.example/', origin: 'import', source_id: 'T', locally_edited: 0 },
    ];
    const src = (url: string, kind: any) => ({ url, kind, column: 'c' });
    const p = planLinks([src('https://new.example/', 'jira'), src('https://same.example/', 'jira'), src('https://kind.example/', 'docs'),
      src('https://edited.example/', 'docs'), src('https://manual.example/', 'jira')], existing, 'S');
    assert.deepEqual(p.add.map((x) => x.url), ['https://new.example/']);
    assert.equal(p.unchanged, 1);
    assert.deepEqual(p.update.map((x) => [x.url, x.from, x.to]), [['https://kind.example/', 'other', 'docs']]);
    assert.deepEqual(p.conflicts.map((x) => [x.url, x.local, x.source]), [['https://edited.example/', 'other', 'docs']]);
    assert.deepEqual(p.kept, ['https://manual.example/'], 'a manual link is never touched');
    assert.deepEqual(p.missing.map((x) => x.url), ['https://gone.example/'], 'only this source\'s untouched links can go missing');
  });

  test('flat conversion: mapped columns, URLs in the task text, hidden hyperlinks of a cell', () => {
    const rows = parseCsv(csv([HEADER, ['XG-1', 'Задача https://my.kokocgroup.ru/workgroups/group/2669/tasks/task/view/399512/', 'Спека: https://wiki.example.com/page', 'XG-1', 'https://docs.google.com/document/d/a/edit https://docs.google.com/document/d/b/edit']]));
    const hyper: string[][] = [];
    (hyper[1] ??= [])[3] = 'https://jira.ly9.ru/browse/XG-1';
    const out = flatToCanonical(rows, FLAT as any, [], '2026-10-13', hyper);
    const [h, r1] = out.rows;
    const links = decodeLinks(r1[h.indexOf('links')]).links;
    assert.deepEqual(links.map((l) => `${l.kind} ${l.url}`), [
      'jira https://jira.ly9.ru/browse/XG-1',
      'docs https://docs.google.com/document/d/a/edit',
      'docs https://docs.google.com/document/d/b/edit',
      'bitrix24 https://my.kokocgroup.ru/workgroups/group/2669/tasks/task/view/399512/',
      'docs https://wiki.example.com/page',
    ]);
    assert.deepEqual(out.problems.get(1) ?? [], [], '«XG-1» text with a hidden hyperlink is a valid link cell');
    // the bugs preset: «задача в jira» is the stable id AND a Jira link, no longer copied into the description
    assert.deepEqual(BUGS_CONFIG.links, { 'задача в jira': 'jira' });
    assert.ok(!(BUGS_CONFIG.columns.extra ?? []).includes('задача в jira'));
  });
});

describe('link import: preview and apply', () => {
  test('create with links, counters in the preview, invalid cell reported, idempotent re-import', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await source(app, pm);
    const rows = [
      ['XG-1', 'Первая', 'Смотри https://my.kokocgroup.ru/workgroups/group/1/tasks/task/view/7/.', 'https://jira.ly9.ru/browse/XG-1', 'https://wiki.example.com/a\nhttps://wiki.example.com/b'],
      ['XG-2', 'Вторая', '', 'https://jira.ly9.ru/browse/XG-2', 'см. вики'],
    ];
    const run = await preview(app, pm, src, rows);
    assert.deepEqual({ add: run.links.add, invalid: run.links.invalid }, { add: 5, invalid: 1 });
    assert.ok(item(run, 'XG-2').warnings.some((w: string) => /^Ссылка не импортирована — колонка «Документация»/.test(w)));
    await apply(app, pm, run);
    assert.deepEqual(linksOf(app, 'XG-1').map((l: any) => `${l.kind} ${l.url} ${l.origin}`), [
      'jira https://jira.ly9.ru/browse/XG-1 import',
      'bitrix24 https://my.kokocgroup.ru/workgroups/group/1/tasks/task/view/7/ import',
      'docs https://wiki.example.com/a import',
      'docs https://wiki.example.com/b import',
    ].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1])));
    // a second sync of the same data changes nothing and duplicates nothing
    const again = await preview(app, pm, src, rows);
    assert.ok(again.items.every((i: any) => i.action === 'unchanged'), JSON.stringify(again.items.map((i: any) => i.action)));
    assert.equal(again.links.add, 0);
    await apply(app, pm, again);
    assert.equal(linksOf(app, 'XG-1').length, 4);
  });

  test('manual links survive; a vanished link is «нет в источнике» and removed only on request; hand edit → conflict', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await source(app, pm);
    await apply(app, pm, await preview(app, pm, src, [['XG-1', 'Первая', '', 'https://jira.ly9.ru/browse/XG-1', 'https://wiki.example.com/a\nhttps://wiki.example.com/b']]));
    const f = app.one(`SELECT id FROM features WHERE external_ref = 'XG-1'`).id;
    assert.equal((await app.call('POST', `/api/features/${f}/links`, { url: 'https://manual.example.com/spec', kind: 'docs' }, pm)).status, 201);
    // hand edit of the imported Jira link (kind) → the source keeps saying "jira"
    const jira = app.one(`SELECT id, version FROM feature_links WHERE url = 'https://jira.ly9.ru/browse/XG-1'`);
    assert.equal((await app.call('PATCH', `/api/links/${jira.id}`, { kind: 'other', version: jira.version }, pm)).status, 200);
    // the sheet: wiki/b disappears, the Documentation cell of… nothing else; manual link not in the sheet at all
    const run = await preview(app, pm, src, [['XG-1', 'Первая', '', 'https://jira.ly9.ru/browse/XG-1', 'https://wiki.example.com/a']]);
    const it = item(run, 'XG-1');
    assert.equal(it.action, 'update');
    const plan = it.payload.link_plan;
    assert.deepEqual(plan.missing.map((m: any) => m.url), ['https://wiki.example.com/b']);
    assert.deepEqual(plan.conflicts.map((c: any) => [c.url, c.local, c.source]), [['https://jira.ly9.ru/browse/XG-1', 'other', 'jira']]);
    assert.deepEqual(run.links, { add: 0, update: 0, conflicts: 1, missing: 1, remove: 0, invalid: 0, on_undecided_rows: 0, rows: 1 });
    // default: keep everything local
    const res1 = await apply(app, pm, run);
    assert.equal(res1.counts.links.kept_missing, 1);
    assert.equal(res1.counts.links.conflicts_local, 1);
    assert.ok(linksOf(app, 'XG-1').some((l: any) => l.url === 'https://wiki.example.com/b'), 'not removed without an explicit choice');
    assert.equal(linksOf(app, 'XG-1').find((l: any) => l.url.includes('XG-1')).kind, 'other', 'hand edit kept');
    assert.ok(linksOf(app, 'XG-1').some((l: any) => l.url === 'https://manual.example.com/spec' && l.origin === 'manual'));
    // explicit choice: remove the vanished one, take the source for the conflict
    const run2 = await preview(app, pm, src, [['XG-1', 'Первая', '', 'https://jira.ly9.ru/browse/XG-1', 'https://wiki.example.com/a']]);
    const it2 = item(run2, 'XG-1');
    const bad = await app.call('PATCH', `/api/import/runs/${run2.id}/items/${it2.id}`, { resolution: { ...it2.resolution, links: { remove: ['https://manual.example.com/spec'] } } }, pm);
    assert.equal(bad.status, 400, 'a manual link can never be chosen for removal');
    const ok = await app.call('PATCH', `/api/import/runs/${run2.id}/items/${it2.id}`, { resolution: { ...it2.resolution, links: { remove: ['https://wiki.example.com/b'], source: ['https://jira.ly9.ru/browse/XG-1'] } } }, pm);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const res2 = await apply(app, pm, run2);
    assert.equal(res2.counts.links.removed, 1);
    assert.deepEqual(linksOf(app, 'XG-1').map((l: any) => `${l.kind} ${l.url} ${l.origin} ${l.locally_edited}`).sort(), [
      'docs https://manual.example.com/spec manual 0',
      'docs https://wiki.example.com/a import 0',
      'jira https://jira.ly9.ru/browse/XG-1 import 0',
    ]);
    // an empty link cell never deletes manual links
    await apply(app, pm, await preview(app, pm, src, [['XG-1', 'Первая', '', '', '']]));
    assert.ok(linksOf(app, 'XG-1').some((l: any) => l.origin === 'manual'));
    assert.equal(linksOf(app, 'XG-1').length, 3, 'imported links that vanished are only marked, not deleted');
    // audit on the task
    assert.ok(app.one(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'import_links'`, f).n >= 2);
  });

  test('a source without link settings never touches links (existing TaskFlow sources keep working)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await source(app, pm, { ...FLAT, links: undefined, links_from_text: undefined });
    await apply(app, pm, await preview(app, pm, src, [['XG-1', 'Первая https://jira.ly9.ru/browse/XG-1', '', 'https://jira.ly9.ru/browse/XG-1', '']]));
    assert.equal(linksOf(app, 'XG-1').length, 0);
  });

  test('Google source: hidden hyperlinks are read from the Sheets API only — no request to Jira / Bitrix24 / Confluence', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
    app.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'ro@project.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n` });
    const hosts = new Set<string>();
    let chipsTried = 0;
    app.env.__FETCH = (async (url: string) => {
      const u = new URL(String(url));
      hosts.add(u.hostname);
      if (u.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      if (u.pathname.endsWith('/values:batchGet')) {
        return new Response(JSON.stringify({ valueRanges: [{ values: [HEADER, ['XG-7', 'Задача из Google', '', 'XG-7', 'Спецификация']] }] }), { status: 200 });
      }
      if (u.searchParams.get('includeGridData') === 'true') {
        const fields = u.searchParams.get('fields') ?? '';
        if (fields.includes('chipRuns')) { chipsTried++; return new Response('{"error":{"message":"Invalid field chipRuns"}}', { status: 400 }); }
        const ranges = u.searchParams.getAll('ranges');
        assert.deepEqual(ranges, ["'Задачи'!D:D", "'Задачи'!E:E", "'Задачи'!B:B", "'Задачи'!C:C"], 'only the link columns (and task text) are read');
        return new Response(JSON.stringify({ sheets: [{ data: [
          { startRow: 0, startColumn: 3, rowData: [{ values: [{}] }, { values: [{ hyperlink: 'https://jira.ly9.ru/browse/XG-7' }] }] },
          { startRow: 0, startColumn: 4, rowData: [{ values: [{}] }, { values: [{ textFormatRuns: [{ format: {} }, { format: { link: { uri: 'https://confluence.example.com/display/P/Spec' } } }] }] }] },
          { startRow: 0, startColumn: 1, rowData: [] },
          { startRow: 0, startColumn: 2, rowData: [] },
        ] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ properties: { title: 'Тест' }, sheets: [{ properties: { title: 'Задачи' } }] }), { status: 200 });
    }) as typeof fetch;
    const s = await app.call('POST', '/api/import/sources', { name: 'Google', kind: 'google', spreadsheet: '1AbcdefghijklmnopqrstuvwxyzABCDEFGHIJ', config: { format: 'flat', flat: FLAT, newVisibility: 'internal' } }, pm);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const pv = await app.call('POST', `/api/import/sources/${s.body.id}/preview`, {}, pm);
    assert.equal(pv.status, 201, JSON.stringify(pv.body));
    assert.equal(chipsTried, 1, 'smart-chip field mask retried without chipRuns');
    assert.equal(pv.body.run.links.invalid, 0, '«XG-7» / «Спецификация» are link cells thanks to their hidden hyperlinks');
    await apply(app, pm, pv.body.run);
    assert.deepEqual(linksOf(app, 'XG-7').map((l: any) => `${l.kind} ${l.url}`), ['docs https://confluence.example.com/display/P/Spec', 'jira https://jira.ly9.ru/browse/XG-7']);
    assert.deepEqual([...hosts].sort(), ['oauth2.googleapis.com', 'sheets.googleapis.com'], 'no request to Jira, Bitrix24 or Confluence');
  });
});

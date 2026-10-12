import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { derivedId, flatToCanonical, parseLooseDate, splitTaskCell, TASKFLOW_CONFIG } from '../worker/domain/flatSheet';
import { setup, type TestApp } from './helpers';

const HEADER = 'Категория,Сотрудник,Задача,Комментарий,Изначальный срок,Новый срок,Влетевшая,Сделано,Дата выполнения,Оценка в часах,Факт в часах,Приоритет';
const ROWS = [
  'Платформа,Анна,Описать флоу выплат,Нужно до релиза,19.10,,Нет,Нет,,8,,1',
  'Платформа,Борис,"https://portal.example/tasks/377550/\n- Контроль запуска оффера\n- поменять дату",,01.10,05.10,Да,Да,04.10,4,5,2',
  ',,https://portal.example/tasks/400001/,,,,,,,,,',
  'Аналитика,Анна,Ссылка сплит трафика,,,,,,,2,,',
  'Аналитика,Анна,Ссылка сплит трафика,дубль строки,,,,,,2,,',
  ',,,,,,,,,,,',
];
const csv = (rows: string[]) => [HEADER, ...rows].join('\n');

async function flatSource(app: TestApp, cookie: string, kind: 'csv' | 'google' = 'csv') {
  const config = { format: 'flat', flat: TASKFLOW_CONFIG, newVisibility: 'internal' };
  const r = await app.call('POST', '/api/import/sources', { name: 'TaskFlow', kind, config, ...(kind === 'google' ? { spreadsheet: '1TestSheetIdForFlatFormat0000000000000000000' } : {}) }, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}

async function upload(app: TestApp, cookie: string, src: string, text: string) {
  const s = (await app.call('GET', '/api/import/sources', undefined, cookie)).body.sources.find((x: any) => x.id === src);
  const r = await app.call('PUT', `/api/import/sources/${src}/csv`, { sheets: { flat: text }, version: s.version }, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function preview(app: TestApp, cookie: string, src: string, body: unknown = {}) {
  const r = await app.call('POST', `/api/import/sources/${src}/preview`, body, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.run;
}

async function apply(app: TestApp, cookie: string, run: any) {
  const r = await app.call('POST', `/api/import/runs/${run.id}/apply`, {}, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const byTitle = (run: any, title: string) => run.items.filter((i: any) => i.payload?.title === title);

describe('flat sheet: conversion', () => {
  test('derived ids depend on task text and assignee only', () => {
    assert.equal(derivedId('Описать флоу выплат', 'Анна'), derivedId('  описать   флоу выплат ', 'анна'));
    assert.notEqual(derivedId('Описать флоу выплат', 'Анна'), derivedId('Описать флоу выплат', 'Борис'));
    assert.match(derivedId('x', ''), /^tf-[0-9a-f]{12}$/);
  });

  test('task cell: links go to the description, first line is the title', () => {
    const a = splitTaskCell('https://portal.example/tasks/377550/\n- контроль запуска\n- поменять дату');
    assert.equal(a.title, 'Контроль запуска');
    assert.deepEqual(a.extraLines, ['поменять дату']);
    assert.deepEqual(a.links, ['https://portal.example/tasks/377550/']);
    assert.equal(splitTaskCell('https://portal.example/tasks/400001/').title, 'Задача портала № 400001');
  });

  test('short dates use the nearest year', () => {
    assert.equal(parseLooseDate('19.10', '2026-10-12'), '2026-10-19');
    assert.equal(parseLooseDate('05.01', '2026-12-20'), '2027-01-05');
    assert.equal(parseLooseDate('28.12', '2027-01-03'), '2026-12-28');
    assert.equal(parseLooseDate('31.02', '2026-10-12'), null);
    assert.equal(parseLooseDate('19.10.2025', '2026-10-12'), '2025-10-19');
  });

  test('status, tags, hours and description', () => {
    const rows = [HEADER.split(','), ...ROWS.slice(0, 2).map((r) => r.split(',').map((c) => c.replace(/^"|"$/g, '')))];
    // row 2 has a quoted multi-line cell with commas — build it explicitly
    rows[2] = ['Платформа', 'Борис', 'https://portal.example/tasks/377550/\n- Контроль запуска оффера\n- поменять дату', '', '01.10', '05.10', 'Да', 'Да', '04.10', '4', '5', '2'];
    const out = flatToCanonical(rows, TASKFLOW_CONFIG, ['backend', 'product'], '2026-10-12');
    assert.deepEqual(out.missing, []);
    const [h, r1, r2] = out.rows;
    const at = (r: string[], k: string) => r[h.indexOf(k)];
    assert.equal(at(r1, 'status'), 'in_progress');
    assert.equal(at(r1, 'planned_end'), '2026-10-19');
    assert.equal(at(r1, 'tags'), 'P1');
    assert.equal(at(r1, 'product_hours'), '8');
    assert.equal(at(r2, 'title'), 'Контроль запуска оффера');
    assert.equal(at(r2, 'status'), 'done');
    assert.equal(at(r2, 'planned_end'), '2026-10-05', '«Новый срок» wins over the original deadline');
    assert.equal(at(r2, 'closed_at'), '2026-10-04');
    assert.equal(at(r2, 'tags'), 'P2, влетевшая');
    assert.match(at(r2, 'description'), /поменять дату[\s\S]*Ссылки:\n- https:\/\/portal\.example\/tasks\/377550\/[\s\S]*Факт: 5 ч/);
  });
});

describe('flat sheet: sync', () => {
  test('first import creates internal cards; duplicate rows are errors; blank rows are ignored', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await flatSource(app, pm);
    await upload(app, pm, src, csv(ROWS));
    const before = app.one('SELECT COUNT(*) AS n FROM features').n;
    const run = await preview(app, pm, src);
    assert.equal(run.summary.create, 4);
    assert.equal(run.summary.error, 1);
    const dupe = run.items.find((i: any) => i.action === 'error');
    assert.match(dupe.errors.join(' '), /та же задача с тем же исполнителем уже есть в строке 5/);
    assert.equal(run.unresolved.length, 0);
    const res = await apply(app, pm, run);
    assert.equal(res.counts.created, 4);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM features').n - before, 4);

    const f = app.one("SELECT * FROM features WHERE title = 'Контроль запуска оффера'");
    assert.equal(f.visibility, 'internal');
    assert.equal(f.assignee_name, 'Борис');
    assert.equal(f.planned_end, '2026-10-05');
    assert.equal(f.closed_at, '2026-10-04');
    assert.equal(f.status_id, 'st_f_done');
    assert.equal(f.external_ref, null, 'derived ids are not shown as an external reference');
    assert.deepEqual(app.many('SELECT tag FROM feature_tags WHERE feature_id = ? ORDER BY tag', f.id).map((t) => t.tag), ['P2', 'влетевшая']);
    assert.equal(app.one("SELECT hours FROM feature_estimates WHERE feature_id = ? AND team_id = 'team_product'", f.id).hours, 4);
    const portal = app.one("SELECT * FROM features WHERE title = 'Задача портала № 400001'");
    assert.equal(portal.status_id, 'st_f_new');
  });

  test('re-import is idempotent and ignores row order; edits update the same card', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await flatSource(app, pm);
    await upload(app, pm, src, csv(ROWS));
    await apply(app, pm, await preview(app, pm, src));

    // reorder (the duplicate pair keeps its relative order: the first occurrence is the one imported)
    await upload(app, pm, src, csv([ROWS[5], ROWS[3], ROWS[4], ROWS[2], ROWS[1], ROWS[0]]));
    const again = await preview(app, pm, src);
    assert.equal(again.summary.create, 0);
    assert.equal(again.summary.update, 0);
    assert.equal(again.summary.unchanged, 4);

    const edited = [...ROWS];
    edited[0] = 'Платформа,Анна,Описать флоу выплат,Нужно до релиза,19.10,26.10,Нет,Да,25.10,8,,1';
    await upload(app, pm, src, csv(edited));
    const run = await preview(app, pm, src);
    assert.equal(run.summary.update, 1);
    const it = byTitle(run, 'Описать флоу выплат')[0];
    assert.deepEqual(it.diff.map((d: any) => d.field).sort(), ['planned_end', 'status_id'].sort());
    await apply(app, pm, run);
    const f = app.one("SELECT * FROM features WHERE title = 'Описать флоу выплат'");
    assert.equal(f.planned_end, '2026-10-26');
    assert.equal(f.status_id, 'st_f_done');
    assert.equal(f.closed_at, '2026-10-25');
    assert.equal(app.one('SELECT COUNT(*) AS n FROM features WHERE title = ?', 'Описать флоу выплат').n, 1);
  });

  test('status follows the sheet unless it was changed in the system', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await flatSource(app, pm);
    await upload(app, pm, src, csv(ROWS.slice(0, 1)));
    await apply(app, pm, await preview(app, pm, src));
    app.one("UPDATE features SET status_id = 'st_f_blocked', version = version + 1 WHERE title = 'Описать флоу выплат' RETURNING id");
    await upload(app, pm, src, csv(['Платформа,Анна,Описать флоу выплат,Нужно до релиза,19.10,,Нет,Да,,8,,1']));
    const run = await preview(app, pm, src);
    const d = byTitle(run, 'Описать флоу выплат')[0].diff.find((x: any) => x.field === 'status_id');
    assert.equal(d.kind, 'protected', 'a local status decision is never overwritten silently');
    await apply(app, pm, run);
    assert.equal(app.one("SELECT status_id FROM features WHERE title = 'Описать флоу выплат'").status_id, 'st_f_blocked');
  });

  test('renamed task comes as a duplicate and can be linked to the old card', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await flatSource(app, pm);
    await upload(app, pm, src, csv(ROWS.slice(0, 1)));
    await apply(app, pm, await preview(app, pm, src));
    const old = app.one("SELECT id FROM features WHERE title = 'Описать флоу выплат'");
    // the same task reassigned → new derived id, same title → exact-title duplicate
    await upload(app, pm, src, csv(['Платформа,Борис,Описать флоу выплат,Нужно до релиза,19.10,,Нет,Нет,,8,,1']));
    const run = await preview(app, pm, src);
    assert.equal(run.summary.duplicate, 1);
    const bulk = await app.call('POST', `/api/import/runs/${run.id}/bulk`, { action: 'link_exact_duplicates' }, pm);
    assert.equal(bulk.body.changed, 1);
    const res = await apply(app, pm, run);
    assert.equal(res.counts.linked, 1);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM features WHERE title = ?', 'Описать флоу выплат').n, 1);
    // next sync updates the linked card in place
    const next = await preview(app, pm, src);
    const it = byTitle(next, 'Описать флоу выплат')[0];
    assert.equal(it.target_id, old.id);
  });

  test('google source can be synced from an uploaded CSV export without a service account', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await flatSource(app, pm, 'google');
    const run = await preview(app, pm, src, { files: { flat: csv(ROWS.slice(0, 2)) } });
    assert.equal(run.origin, 'file');
    assert.equal(run.summary.create, 2);
    const res = await apply(app, pm, run);
    assert.equal(res.counts.created, 2);
    const again = await preview(app, pm, src, { files: { flat: csv(ROWS.slice(0, 2)) } });
    assert.equal(again.summary.unchanged, 2);
  });

  test('check reports missing mapped columns', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await flatSource(app, pm);
    await upload(app, pm, src, 'Задача,Сотрудник\nПервая,Анна\n');
    const r = await app.call('POST', `/api/import/sources/${src}/check`, {}, pm);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, 'title column is enough to import');
    assert.equal(r.body.sheets[0].rows, 1);
    assert.ok(r.body.sheets[0].missing_columns.includes('Сделано'));
    const run = await preview(app, pm, src);
    assert.equal(run.summary.create, 1);
    assert.ok(run.items.some((i: any) => i.entity_type === 'sheet' && i.warnings.join(' ').includes('Сделано')));
  });
});

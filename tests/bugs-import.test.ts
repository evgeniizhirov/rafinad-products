// P05 / FR-07, FR-09: bugs and operational improvements from «Прием обращений по багам/доработкам».
// Headers copy the real tabs (read on 2026-10-13); the data rows are synthetic.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUGS_CONFIG, flatToCanonical, IMPROVEMENTS_CONFIG } from '../worker/domain/flatSheet';
import { parseCsv } from '../worker/domain/csv';
import { setup, type TestApp } from './helpers';

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
const line = (cells: string[]) => cells.map(q).join(',');

const BUG_HEADER = ['Запрос от', 'Запрос от', 'Постановщик', 'Название', 'На что влияет', 'Приоритет', 'задача в jira',
  'Статус (блокируются задачи только по внешним причинам)', 'Постановщик задачи', 'Комментарий', 'Проект', 'hotfix',
  'Дата обращения в продуктовый отдел', 'Дата заведения\nзадачи / бага в разработку', 'Сроки релиза фактический', 'Сроки релиза плановый',
  'Комментарий 2', 'фактическое кол-во часов ', 'KPI Заведения (продуктовый)', '', '', '26 - просрочено\n60 - раньше срока'];
const bug = (o: Partial<Record<string, string>>) => [
  o.from0 ?? '', o.from ?? '', o.author ?? 'Тестов Тест', o.title ?? 'Не работает фильтр', o.impact ?? 'Неверная статистика', o.prio ?? 'Средний',
  o.jira ?? 'https://jira.example/browse/XG-1001', o.status ?? 'Новый', '', o.comment ?? '', 'New Rafinad', o.hotfix ?? 'нет',
  o.req ?? '13.08', o.req ?? '13.08', o.fact ?? '', o.plan ?? '29.10', '', o.hours ?? '', '', '', '', ''];

const IMP_HEADER = ['Запрос от ', 'Постановщик задачи', 'Название', 'Какую проблему решает', 'Приоритет', 'задача в jira', 'Статус', 'Комментарий',
  'Проект', 'hotfix', 'Дата обращения в продуктовый отдел', 'Дата заведения\nзадачи / бага в разработку', 'Сроки релиза факт', 'Сроки релиза план',
  'факт. кол-во часов ', 'Комментарий', 'Отклонение от сроков', 'KPI продуктов'];
const imp = (o: Partial<Record<string, string>>) => [o.from ?? 'Отдел продаж', 'Тестов Тест', o.title ?? 'Колонка бренда в выгрузке', 'Нет нужных данных', o.prio ?? 'Высокий',
  o.jira ?? 'https://jira.example/browse/XG-2001', o.status ?? 'Контроль', 'блок', 'New Rafinad', 'да', '04.09', '04.09', '', '01.10', '', 'второй комментарий', '', ''];

const bugsCsv = (rows: string[][]) => [line(BUG_HEADER), ...rows.map(line)].join('\n');

async function source(app: TestApp, cookie: string, flat: unknown, name: string) {
  const r = await app.call('POST', '/api/import/sources', { name, kind: 'csv', config: { format: 'flat', flat, newVisibility: 'internal' } }, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}
async function sync(app: TestApp, cookie: string, src: string, csv: string, apply = true) {
  const s = (await app.call('GET', '/api/import/sources', undefined, cookie)).body.sources.find((x: any) => x.id === src);
  assert.equal((await app.call('PUT', `/api/import/sources/${src}/csv`, { sheets: { flat: csv }, version: s.version }, cookie)).status, 200);
  const pv = await app.call('POST', `/api/import/sources/${src}/preview`, {}, cookie);
  assert.equal(pv.status, 201, JSON.stringify(pv.body));
  if (apply) {
    const a = await app.call('POST', `/api/import/runs/${pv.body.run.id}/apply`, {}, cookie);
    assert.equal(a.status, 200, JSON.stringify(a.body));
  }
  return pv.body.run;
}

describe('bugs sheet conversion', () => {
  test('real headers: Jira key id, duplicate «Запрос от», status/urgency maps, dates, hotfix, extras', () => {
    const rows = parseCsv(bugsCsv([
      bug({ from: 'Финансы', jira: 'https://jira.example/browse/XG-4642 ', status: 'В работе', prio: 'Высокий', hotfix: 'да', comment: 'релиз', hours: '3,5' }),
      bug({ jira: '', title: 'Без задачи в jira', status: 'Странный', plan: '', fact: '20.10' }),
    ]));
    const out = flatToCanonical(rows, BUGS_CONFIG, [], '2026-10-13');
    const [h, r1, r2] = out.rows;
    const at = (r: string[], k: string) => r[h.indexOf(k)];
    assert.deepEqual(out.missing, []);
    assert.equal(at(r1, 'external_id'), 'XG-4642');
    assert.equal(out.derived.get(1), false);
    assert.equal(at(r1, 'task_kind'), 'bug');
    assert.equal(at(r1, 'status'), 'in_progress');
    assert.equal(at(r1, 'urgency'), 'high');
    assert.equal(at(r1, 'initiator'), 'Финансы', 'second «Запрос от» column is used when the first is empty');
    assert.equal(at(r1, 'requested_at'), '2026-08-13');
    assert.equal(at(r1, 'planned_end'), '2026-10-29');
    assert.equal(at(r1, 'fact_hours'), '3.5');
    assert.equal(at(r1, 'tags'), 'hotfix');
    assert.match(at(r1, 'description'), /Неверная статистика[\s\S]*Комментарий: релиз[\s\S]*Проект: New Rafinad/);
    // no Jira link → derived id; actual date → done; unknown status → warning, status left as is
    assert.match(at(r2, 'external_id'), /^tf-/);
    assert.equal(at(r2, 'status'), 'done');
    assert.equal(at(r2, 'closed_at'), '2026-10-20');
    assert.ok(out.problems.get(2)?.some((p) => /Странный/.test(p)));
  });

  test('improvements tab: kind, «Контроль» = in progress, both «Комментарий» columns', () => {
    const rows = parseCsv([line(IMP_HEADER), line(imp({}))].join('\n'));
    const out = flatToCanonical(rows, IMPROVEMENTS_CONFIG, [], '2026-10-13');
    const [h, r1] = out.rows;
    const at = (k: string) => r1[h.indexOf(k)];
    assert.deepEqual(out.missing, []);
    assert.equal(at('task_kind'), 'operational_improvement');
    assert.equal(at('status'), 'in_progress');
    assert.equal(at('external_id'), 'XG-2001');
    assert.match(at('description'), /Комментарий: блок/);
  });
});

describe('bugs sync', () => {
  test('creates bugs out of planning; idempotent; Jira id keeps renamed rows; manual edits are not overwritten silently', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product', [], 'Анна ПМ');
    app.many("UPDATE users SET name = 'Дмитрий Мхитарян' WHERE email = 'pm@test.io' RETURNING 1");
    const src = await source(app, pm, BUGS_CONFIG, 'Баги');
    const rows = [
      bug({ from: 'Финансы', jira: 'https://jira.example/browse/XG-1', title: 'Баг один', status: 'В работе', prio: 'Высокий' }),
      bug({ from: 'Мхитарян Дмитрий', jira: 'https://jira.example/browse/XG-2', title: 'Баг два', plan: '' }),
      bug({ from: 'Иванов Иван', jira: 'https://jira.example/browse/XG-3', title: 'Баг три', fact: '10.10', hours: '4' }),
    ];
    const run = await sync(app, pm, src, bugsCsv(rows));
    assert.equal(run.summary.create, 3);
    const f = (ref: string) => app.one('SELECT * FROM features WHERE external_ref = ?', ref);
    const b1 = f('XG-1');
    assert.equal(b1.task_kind, 'bug');
    assert.equal(b1.urgency, 'high');
    assert.equal(b1.status_id, 'st_f_progress');
    assert.equal(b1.planned_end, '2026-10-29');
    assert.equal(b1.visibility, 'internal');
    assert.equal(b1.initiator_type, 'department');
    assert.equal(b1.initiator_department_id, 'dep_finance');
    assert.equal(f('XG-2').initiator_type, 'user', '«Мхитарян Дмитрий» = user «Дмитрий Мхитарян»');
    assert.equal(f('XG-3').initiator_type, 'free_text');
    assert.equal(f('XG-3').status_id, 'st_f_done');
    assert.equal(f('XG-3').closed_at, '2026-10-10');
    assert.equal(f('XG-3').fact_hours, 4);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM feature_estimates WHERE feature_id = ?', b1.id).n, 0);

    // bugs never enter planning (T11 server side)
    const plan = (await app.call('POST', '/api/planning/propose', {}, pm)).body;
    assert.ok(!JSON.stringify(plan).includes(b1.id));
    // bugs list
    const list = (await app.call('GET', '/api/features?kind=bug', undefined, pm)).body.features;
    assert.equal(list.length, 3);
    assert.equal(list.find((x: any) => x.key === `RF-${b1.number}`).urgency, 'high');

    // same sheet again: nothing changes (T13)
    const again = await sync(app, pm, src, bugsCsv(rows), false);
    assert.equal(again.summary.create + again.summary.update + again.summary.duplicate, 0);
    assert.equal(again.summary.unchanged, 3);

    // renamed in the sheet: same card (stable Jira id), title updated
    rows[0] = bug({ from: 'Финансы', jira: 'https://jira.example/browse/XG-1', title: 'Баг один (уточнено)', status: 'В работе', prio: 'Высокий' });
    const renamed = await sync(app, pm, src, bugsCsv(rows), false);
    assert.equal(renamed.summary.create, 0);
    assert.equal(renamed.summary.update, 1);

    // manual urgency change in the system survives a sync where the sheet did not change it
    const cur = f('XG-2');
    assert.equal((await app.call('PATCH', `/api/features/${cur.id}`, { urgency: 'critical', version: cur.version }, pm)).status, 200);
    const keep = await sync(app, pm, src, bugsCsv(rows), false);
    const it = keep.items.find((i: any) => i.external_id === 'XG-2');
    assert.ok(!it.diff.some((d: any) => d.field === 'urgency'), 'local edit wins silently while the sheet keeps the old value');
    // sheet changes it too → conflict, never silent
    rows[1] = bug({ from: 'Мхитарян Дмитрий', jira: 'https://jira.example/browse/XG-2', title: 'Баг два', plan: '', prio: 'Низкий' });
    const conflict = await sync(app, pm, src, bugsCsv(rows), false);
    assert.equal(conflict.items.find((i: any) => i.external_id === 'XG-2').diff.find((d: any) => d.field === 'urgency').kind, 'conflict');
    // status follows the sheet (flat source) while it was not changed in the system
    rows[1] = bug({ from: 'Мхитарян Дмитрий', jira: 'https://jira.example/browse/XG-2', title: 'Баг два', plan: '', status: 'Готово' });
    const st = await sync(app, pm, src, bugsCsv(rows), false);
    assert.equal(st.items.find((i: any) => i.external_id === 'XG-2').diff.find((d: any) => d.field === 'status_id').kind, 'update');
  });

  test('improvements source gives operational_improvement; bug → planned conversion drops the reference sprint', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await source(app, pm, IMPROVEMENTS_CONFIG, 'Доработки');
    await sync(app, pm, src, [line(IMP_HEADER), line(imp({}))].join('\n'));
    const x = app.one("SELECT * FROM features WHERE external_ref = 'XG-2001'");
    assert.equal(x.task_kind, 'operational_improvement');
    assert.equal(x.initiator_type, 'free_text');
    assert.ok(app.many('SELECT tag FROM feature_tags WHERE feature_id = ?', x.id).some((t: any) => t.tag === 'hotfix'));
    // reference sprint, then explicit conversion into a planned task
    app.many("INSERT INTO releases (id, name, status_id, created_at, updated_at, cycle_number) VALUES ('rel_c', 'Релиз 8', 'st_r_planned', '2026-10-01', '2026-10-01', 8) RETURNING 1");
    app.many("INSERT INTO sprints (id, release_id, ordinal, code, start_date, end_date, testing_start, production_due, created_at, updated_at) VALUES ('spr_c', 'rel_c', 1, '8.1', '2026-10-07', '2026-10-20', '2026-10-21', '2026-10-29', '2026-10-01', '2026-10-01') RETURNING 1");
    assert.equal((await app.call('PATCH', `/api/features/${x.id}/schedule`, { sprint_id: 'spr_c', version: x.version }, pm)).status, 200);
    const v = app.one('SELECT version FROM features WHERE id = ?', x.id).version;
    assert.equal((await app.call('PATCH', `/api/features/${x.id}`, { task_kind: 'planned', version: v }, pm)).status, 200);
    const after = app.one('SELECT task_kind, sprint_id FROM features WHERE id = ?', x.id);
    assert.equal(after.task_kind, 'planned');
    assert.equal(after.sprint_id, null, 'reference sprint does not turn into a plan commitment');
  });

  test('check reports the real headers as found', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const src = await source(app, pm, BUGS_CONFIG, 'Баги');
    await sync(app, pm, src, bugsCsv([bug({})]), false);
    const r = await app.call('POST', `/api/import/sources/${src}/check`, {}, pm);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.sheets[0].missing_columns, []);
  });
});

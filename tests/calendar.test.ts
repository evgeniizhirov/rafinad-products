// P03 / FR-06: release = two Wed–Tue sprints, production deadline +9 days, months independent of sprints.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addMonths, cycleOn, monthDates, planGeneration, releaseCycle, validateAnchor } from '../worker/domain/calendar';
import { setup, type TestApp } from './helpers';

const ANCHOR = { date: '2026-10-07', release: 8 };
const EMPTY = { releases: [], sprints: [], months: [] };

describe('calendar arithmetic', () => {
  test('release 8 reference dates (T05)', () => {
    const r8 = releaseCycle(ANCHOR, 8);
    assert.deepEqual(r8.sprints[0], { ordinal: 1, code: '8.1', start_date: '2026-10-07', end_date: '2026-10-20', testing_start: '2026-10-21', production_due: '2026-10-29' });
    assert.deepEqual(r8.sprints[1], { ordinal: 2, code: '8.2', start_date: '2026-10-21', end_date: '2026-11-03', testing_start: '2026-11-04', production_due: '2026-11-12' });
    assert.equal(r8.production_due, '2026-11-12');
    const r9 = releaseCycle(ANCHOR, 9);
    assert.equal(r9.sprints[0].start_date, '2026-11-04');
    for (const c of [8, 9, 10, 11, 20]) {
      for (const s of releaseCycle(ANCHOR, c).sprints) {
        assert.equal(new Date(`${s.start_date}T00:00:00Z`).getUTCDay(), 3, `${s.code} starts on Wednesday`);
        assert.equal(new Date(`${s.end_date}T00:00:00Z`).getUTCDay(), 2, `${s.code} ends on Tuesday`);
        assert.equal(new Date(`${s.production_due}T00:00:00Z`).getUTCDay(), 4, `${s.code} production on Thursday`);
      }
    }
    assert.equal(cycleOn(ANCHOR, '2026-10-12'), 8);
    assert.equal(cycleOn(ANCHOR, '2026-11-03'), 8);
    assert.equal(cycleOn(ANCHOR, '2026-11-04'), 9);
    assert.match(validateAnchor({ date: '2026-10-08', release: 8 }) ?? '', /сред/);
  });

  test('months are calendar months, independent of sprints', () => {
    assert.deepEqual(monthDates('2026-10'), { month: '2026-10', start_date: '2026-10-01', end_date: '2026-10-31' });
    assert.equal(monthDates('2028-02').end_date, '2028-02-29');
    assert.equal(addMonths('2026-12', 1), '2027-01');
    // sprint 8.2 crosses the October/November border: it is not a month
    const s = releaseCycle(ANCHOR, 8).sprints[1];
    assert.ok(s.start_date.slice(0, 7) === '2026-10' && s.end_date.slice(0, 7) === '2026-11');
  });

  test('generation plan is idempotent and never touches existing rows', () => {
    const p1 = planGeneration(ANCHOR, EMPTY, { today: '2026-10-12', releasesAhead: 3, monthsAhead: 12 });
    assert.deepEqual(p1.releases.map((r) => r.cycle), [8, 9, 10]);
    assert.deepEqual(p1.sprints.map((s) => s.code), ['8.1', '8.2', '9.1', '9.2', '10.1', '10.2']);
    assert.equal(p1.months[0].month, '2026-10');
    assert.equal(p1.months.length, 12);
    const existing = {
      releases: p1.releases.map((r, i) => ({ id: `r${i}`, cycle_number: r.cycle, name: r.name })),
      sprints: p1.sprints.map((s, i) => ({ id: `s${i}`, code: s.code, release_id: `r${Math.floor(i / 2)}`, start_date: s.start_date, end_date: s.end_date })),
      months: p1.months.map((m) => ({ month: m.month })),
    };
    const p2 = planGeneration(ANCHOR, existing, { today: '2026-10-12', releasesAhead: 3, monthsAhead: 12 });
    assert.equal(p2.releases.length + p2.sprints.length + p2.months.length, 0, 'second run creates nothing (T06)');
    // a hand-edited sprint is reported, not moved; an overlapping new sprint is a conflict, not a duplicate
    existing.sprints[5] = { ...existing.sprints[5], end_date: '2027-01-05' }; // 10.2 extended into 11.1
    const p3 = planGeneration(ANCHOR, existing, { today: '2026-11-20', releasesAhead: 3, monthsAhead: 12 });
    assert.ok(p3.skipped.some((x) => x.code === '10.2' && /вручную/.test(x.reason)));
    assert.ok(p3.conflicts.some((x) => x.code === '11.1'));
    assert.ok(!p3.sprints.some((s) => s.code === '11.1'));
  });
});

async function generate(app: TestApp, cookie: string) {
  const pv = await app.call('POST', '/api/calendar/generate-preview', {}, cookie);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  const g = await app.call('POST', '/api/calendar/generate', { plan_hash: pv.body.plan_hash }, cookie);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  return { preview: pv.body, created: g.body.created };
}

describe('calendar API', () => {
  test('preview → generate creates releases, sprints and months once; leads cannot generate', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    assert.equal((await app.call('POST', '/api/calendar/generate-preview', {}, lead)).status, 403);
    const before = app.one('SELECT COUNT(*) AS n FROM releases').n;
    const { preview, created } = await generate(app, pm);
    assert.ok(created.sprints >= 2 && created.sprints % 2 === 0);
    assert.equal(created.releases * 2, created.sprints);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM releases').n, before + created.releases);
    const r8 = app.one('SELECT * FROM releases WHERE cycle_number = 8');
    assert.equal(r8.planned_date, '2026-11-12');
    assert.deepEqual(app.many("SELECT code, start_date, end_date, testing_start, production_due FROM sprints WHERE release_id = ? ORDER BY ordinal", r8.id).map((x: any) => ({ ...x })), [
      { code: '8.1', start_date: '2026-10-07', end_date: '2026-10-20', testing_start: '2026-10-21', production_due: '2026-10-29' },
      { code: '8.2', start_date: '2026-10-21', end_date: '2026-11-03', testing_start: '2026-11-04', production_due: '2026-11-12' },
    ]);
    assert.ok(app.one("SELECT 1 AS ok FROM accounting_months WHERE month = '2026-10' AND end_date = '2026-10-31'"));
    // second run: nothing to do, nothing duplicated
    const again = await generate(app, pm);
    assert.deepEqual(again.created, { releases: 0, sprints: 0, months: 0 });
    // a stale preview is refused
    const g = await app.call('POST', '/api/calendar/generate', { plan_hash: preview.plan_hash }, pm);
    assert.ok(g.status === 200 || g.status === 409);
    assert.equal(app.one("SELECT COUNT(*) AS n FROM sprints WHERE code = '8.1'").n, 1);
  });

  test('task schedule: release → sprint → production date; move keeps baseline; bugs only reference a sprint (T07)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    await generate(app, pm);
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const s82 = app.one("SELECT * FROM sprints WHERE code = '8.2'");
    const created = await app.call('POST', '/api/features', { title: 'Обязательство релиза 8', is_focus: true }, pm);
    const id = created.body.id;
    const v = () => app.one('SELECT version FROM features WHERE id = ?', id).version;
    assert.equal((await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s81.id, version: v() }, lead)).status, 403);
    const put1 = await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s81.id, version: v() }, pm);
    assert.equal(put1.status, 200, JSON.stringify(put1.body));
    let f = app.one('SELECT * FROM features WHERE id = ?', id);
    assert.equal(f.planned_production_date, '2026-10-29');
    assert.equal(f.baseline_production_date, null, 'not agreed yet: the baseline is fixed when the release plan is approved (vNext)');
    assert.equal(app.one('SELECT release_id FROM release_features WHERE feature_id = ?', id).release_id, s81.release_id);
    const rel81 = app.one('SELECT version FROM releases WHERE id = ?', s81.release_id);
    assert.equal((await app.call('POST', `/api/releases/${s81.release_id}/approve`, { version: rel81.version, approved: true }, pm)).status, 200);
    f = app.one('SELECT * FROM features WHERE id = ?', id);
    assert.equal(f.baseline_production_date, '2026-10-29');
    // move 8.1 → 8.2: new planned date, baseline kept, history written
    const mv = await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s82.id, version: v() }, pm);
    assert.equal(mv.status, 200, JSON.stringify(mv.body));
    f = app.one('SELECT * FROM features WHERE id = ?', id);
    assert.equal(f.planned_production_date, '2026-11-12');
    assert.equal(f.baseline_production_date, '2026-10-29');
    const log = app.one("SELECT action, changes FROM audit_log WHERE entity_id = ? AND action = 'rescheduled'", id);
    assert.deepEqual(JSON.parse(log.changes).find((c: any) => c.field === 'sprint'), { field: 'sprint', old: '8.1', new: '8.2' });
    // the card shows release → sprint → production date
    const card = (await app.call('GET', `/api/features/${id}`, undefined, lead)).body.feature;
    assert.equal(card.sprint.code, '8.2');
    assert.equal(card.release.id, s82.release_id);
    assert.equal(card.planned_production_date, '2026-11-12');
    assert.equal(card.is_focus, true);
    // sprint from another release is refused
    const s91 = app.one("SELECT * FROM sprints WHERE code = '9.1'");
    assert.equal((await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s91.id, release_id: s81.release_id, version: v() }, pm)).status, 400);

    // first delivery does not close the release: release summary counts both sprints
    const done = app.one("SELECT id FROM statuses WHERE entity = 'feature' AND semantic = 'done'").id;
    const other = (await app.call('POST', '/api/features', { title: 'Часть в 8.1', status_id: done }, pm)).body.id;
    // the release is approved by now: adding a task needs an explicit confirmation and makes it agreed (baseline)
    assert.equal((await app.call('PATCH', `/api/features/${other}/schedule`, { sprint_id: s81.id, version: 1 }, pm)).status, 409);
    assert.equal((await app.call('PATCH', `/api/features/${other}/schedule`, { sprint_id: s81.id, version: 1, confirm_approved_change: true, reason: 'Уже сделано' }, pm)).status, 200);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM feature_plan_baselines WHERE feature_id = ?', other).n, 1);
    const rel = (await app.call('GET', `/api/releases/${s81.release_id}`, undefined, pm)).body.release;
    assert.deepEqual(rel.sprints.map((s: any) => [s.code, s.feature_count, s.done_count]), [['8.1', 1, 1], ['8.2', 1, 0]]);
    assert.equal(rel.readiness, 50);
    assert.equal(rel.focus_count, 1);
    assert.equal(rel.focus_done, 0);

    // bug: sprint is a reference only — no release, no plan, no production date
    const bug = (await app.call('POST', '/api/features', { title: 'Баг в выплатах', task_kind: 'bug' }, pm)).body.id;
    assert.equal((await app.call('PATCH', `/api/features/${bug}/schedule`, { sprint_id: s81.id, release_id: s81.release_id, version: 1 }, pm)).status, 400);
    assert.equal((await app.call('PATCH', `/api/features/${bug}/schedule`, { sprint_id: s81.id, version: 1 }, pm)).status, 200);
    const b = app.one('SELECT * FROM features WHERE id = ?', bug);
    assert.equal(b.sprint_id, s81.id);
    assert.equal(b.planned_production_date, null);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM release_features WHERE feature_id = ?', bug).n, 0);
    const sprint = (await app.call('GET', '/api/sprints/8.1', undefined, pm)).body.sprint;
    assert.equal(sprint.planned_count, 1);
    assert.equal(sprint.reference_count, 1);
    assert.ok(!sprint.features.some((x: any) => x.id === bug), 'bug is not part of the sprint plan');
    // focus is only for planned tasks
    assert.equal((await app.call('PATCH', `/api/features/${bug}`, { is_focus: true, version: b.version }, pm)).status, 400);
  });

  test('approved release composition change needs confirmation; leaving a release clears the sprint', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await generate(app, pm);
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const id = (await app.call('POST', '/api/features', { title: 'Задача' }, pm)).body.id;
    assert.equal((await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s81.id, version: 1 }, pm)).status, 200);
    const rel = app.one('SELECT * FROM releases WHERE id = ?', s81.release_id);
    assert.equal((await app.call('POST', `/api/releases/${rel.id}/approve`, { version: rel.version, approved: true }, pm)).status, 200);
    const s82 = app.one("SELECT * FROM sprints WHERE code = '9.1'");
    const r = await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s82.id, version: 2 }, pm);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'approved');
    assert.equal((await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s82.id, version: 2, confirm_approved_change: true, reason: 'Перенос по решению бизнеса' }, pm)).status, 200);
    assert.ok(app.one("SELECT is_override FROM audit_log WHERE entity_type = 'release' AND entity_id = ? ORDER BY id DESC LIMIT 1", rel.id).is_override);
    // removing the task from release 9 via the release composition clears its sprint
    const r9 = app.one('SELECT * FROM releases WHERE id = ?', s82.release_id);
    assert.equal((await app.call('PUT', `/api/releases/${r9.id}/features`, { feature_ids: [], version: r9.version }, pm)).status, 200);
    const f = app.one('SELECT sprint_id, planned_production_date FROM features WHERE id = ?', id);
    assert.equal(f.sprint_id, null);
    assert.equal(f.planned_production_date, null);
  });

  test('editing a sprint exception needs a reason, rejects overlaps and moves dependent dates', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await generate(app, pm);
    const s = app.one("SELECT * FROM sprints WHERE code = '8.2'");
    const id = (await app.call('POST', '/api/features', { title: 'Задача 8.2' }, pm)).body.id;
    await app.call('PATCH', `/api/features/${id}/schedule`, { sprint_id: s.id, version: 1 }, pm);
    const relv = app.one('SELECT version FROM releases WHERE id = ?', s.release_id).version;
    await app.call('POST', `/api/releases/${s.release_id}/approve`, { version: relv, approved: true }, pm);
    assert.equal((await app.call('PATCH', `/api/sprints/${s.id}`, { production_due: '2026-11-13', version: s.version }, pm)).status, 400, 'reason required');
    assert.equal((await app.call('PATCH', `/api/sprints/${s.id}`, { start_date: '2026-10-15', version: s.version, reason: 'x' }, pm)).status, 400, 'overlap with 8.1');
    const ok = await app.call('PATCH', `/api/sprints/${s.id}`, { production_due: '2026-11-13', version: s.version, reason: 'Праздник' }, pm);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(app.one('SELECT planned_production_date FROM features WHERE id = ?', id).planned_production_date, '2026-11-13');
    assert.equal(app.one('SELECT planned_date FROM releases WHERE id = ?', s.release_id).planned_date, '2026-11-13');
    assert.equal(app.one('SELECT baseline_production_date FROM features WHERE id = ?', id).baseline_production_date, '2026-11-12');
  });

  test('calendar view: guests see public releases only; nothing is left of the old periods to map (v2-10)', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await generate(app, pm);
    const guest = (await app.call('GET', '/api/calendar', undefined, null)).body;
    assert.equal(guest.releases.length, 0, 'generated releases are internal');
    assert.deepEqual(guest.months, []);
    const view = (await app.call('GET', '/api/calendar', undefined, pm)).body;
    assert.equal(view.releases[0].cycle_number, 8);
    assert.equal(view.releases[0].sprints.length, 2);
    assert.deepEqual(view.unmapped, [], 'the old planning periods were removed');
  });
});

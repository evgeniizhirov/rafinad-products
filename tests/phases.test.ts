// vNext PR 5 (ТЗ §2.2–2.3, §8 «Общий Гант»): every task has its own phases from the sprint, a baseline captured at
// release approval, confirmed facts, forecasts and deviations; a date passing never completes a phase.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeTimeline, planOf, type SprintDates } from '../worker/domain/phases';
import { setup, type TestApp } from './helpers';

// sprint 8.1 of the generated calendar
const S81: SprintDates = { start_date: '2026-10-07', end_date: '2026-10-20', testing_start: '2026-10-21', production_due: '2026-10-29' };
const S82: SprintDates = { start_date: '2026-10-21', end_date: '2026-11-03', testing_start: '2026-11-04', production_due: '2026-11-12' };
const planned = { task_kind: 'planned', done: false };
const BASE = { revision: 1, dev_start: '2026-10-07', dev_end: '2026-10-20', qa_start: '2026-10-21', qa_end: '2026-10-29', release_date: '2026-10-29' };
const ph = (tl: any, p: string) => tl.phases.find((x: any) => x.phase === p);

describe('phase timeline (pure)', () => {
  test('reopening on the same day stays active for both phases and the release', () => {
    for (const phase of ['dev', 'release'] as const) {
      const tl = computeTimeline(planned, S81, null, [
        { phase, kind: 'start', at: '2026-10-13' },
        { phase, kind: 'done', at: '2026-10-13' },
        { phase, kind: 'start', at: '2026-10-13' },
      ], [], '2026-10-13');
      const part = phase === 'release' ? tl.release : ph(tl, phase);
      assert.equal(part.state, 'active');
      assert.equal(phase === 'release' ? part.fact : part.fact.end, null);
      assert.equal(tl.current, phase);
    }
  });
  test('plan comes from the sprint; product / design have no invented dates; release is a milestone', () => {
    const tl = computeTimeline(planned, S81, null, [], [], '2026-10-01');
    assert.deepEqual(ph(tl, 'dev').plan, { start: '2026-10-07', end: '2026-10-20' });
    assert.deepEqual(ph(tl, 'qa').plan, { start: '2026-10-21', end: '2026-10-29' });
    assert.equal(ph(tl, 'product').plan, null);
    assert.equal(ph(tl, 'design').plan, null);
    assert.equal(tl.release.plan, '2026-10-29');
    assert.equal(tl.agreed, false, 'no baseline → «не согласовано»');
    // individual dates of the task win over the sprint for development
    assert.deepEqual(planOf({ ...planned, planned_start: '2026-10-09', planned_end: '2026-10-15' }, S81).dev, { start: '2026-10-09', end: '2026-10-15' });
    // no sprint and no dates → nothing is drawn
    const none = computeTimeline(planned, null, null, [], [], '2026-10-01');
    assert.equal(ph(none, 'dev').plan, null);
    assert.equal(none.release.plan, null);
    assert.equal(none.plan_source, 'none');
    // a bug without a sprint: only its fix date as a milestone
    assert.equal(computeTimeline({ task_kind: 'bug', done: false, planned_end: '2026-10-25' }, null, null, [], [], '2026-10-01').release.plan, '2026-10-25');
  });

  test('a passed date never completes a phase: «нет подтверждения» instead of fake progress', () => {
    const tl = computeTimeline(planned, S81, BASE, [], [], '2026-10-23');
    assert.equal(ph(tl, 'dev').state, 'unconfirmed');
    assert.equal(ph(tl, 'dev').fact.end, null);
    assert.match(ph(tl, 'dev').risk, /не подтвержд/);
    assert.equal(ph(tl, 'qa').state, 'unconfirmed');
  });

  test('early finish keeps the planned boundary and shows a negative deviation; a delay shows the continuation', () => {
    const early = computeTimeline(planned, S81, BASE, [
      { phase: 'dev', kind: 'start', at: '2026-10-07' }, { phase: 'dev', kind: 'done', at: '2026-10-16' }, { phase: 'qa', kind: 'start', at: '2026-10-16' },
    ], [], '2026-10-18');
    assert.equal(ph(early, 'dev').state, 'done');
    assert.deepEqual(ph(early, 'dev').fact, { start: '2026-10-07', end: '2026-10-16' });
    assert.deepEqual(ph(early, 'dev').plan, { start: '2026-10-07', end: '2026-10-20' }, 'the plan stays visible');
    assert.equal(ph(early, 'dev').deviation_days, -4);
    assert.equal(early.current, 'qa');

    const late = computeTimeline(planned, S81, BASE, [{ phase: 'dev', kind: 'start', at: '2026-10-07' }], [], '2026-10-24');
    assert.equal(ph(late, 'dev').state, 'active');
    assert.equal(ph(late, 'dev').forecast_end, '2026-10-24', 'continuation after the boundary until confirmed');
    assert.equal(ph(late, 'dev').deviation_days, 4);
    assert.match(ph(late, 'dev').risk, /Срок этапа прошёл/);
    // Product's forecast with a reason replaces the automatic one — and never touches the baseline
    const fc = computeTimeline(planned, S81, BASE, [{ phase: 'dev', kind: 'start', at: '2026-10-07' }], [{ phase: 'dev', end_date: '2026-10-27', reason: 'Ждём API банка' }], '2026-10-24');
    assert.equal(ph(fc, 'dev').forecast_end, '2026-10-27');
    assert.equal(ph(fc, 'dev').forecast_reason, 'Ждём API банка');
    assert.equal(ph(fc, 'dev').risk, null);
    assert.equal(fc.release.forecast, '2026-10-29', 'dev ends before the planned release: no push');
    const push = computeTimeline(planned, S81, BASE, [{ phase: 'qa', kind: 'start', at: '2026-10-21' }], [{ phase: 'qa', end_date: '2026-11-02', reason: 'Регресс' }], '2026-10-24');
    assert.equal(push.release.forecast, '2026-11-02', 'a late QA pushes the release forecast');
    assert.equal(push.release.deviation_days, 4);
    assert.match(push.release.risk ?? '', /сдвигается/);
    assert.deepEqual(ph(fc, 'dev').baseline, { start: '2026-10-07', end: '2026-10-20' });
  });

  test('moving to another sprint changes the plan, not the baseline; an untouched earlier phase is skipped', () => {
    const tl = computeTimeline(planned, S82, BASE, [{ phase: 'dev', kind: 'start', at: '2026-10-21' }], [], '2026-10-22');
    assert.deepEqual(ph(tl, 'dev').plan, { start: '2026-10-21', end: '2026-11-03' });
    assert.deepEqual(ph(tl, 'dev').baseline, { start: '2026-10-07', end: '2026-10-20' });
    assert.equal(ph(tl, 'dev').deviation_days, 14, 'forecast end vs baseline end');
    assert.equal(tl.release.deviation_days, 14);
    assert.equal(ph(tl, 'design').state, 'skipped');
    assert.equal(ph(tl, 'product').state, 'skipped');
  });
});

async function calendar(app: TestApp, cookie: string) {
  const pv = (await app.call('POST', '/api/calendar/generate-preview', {}, cookie)).body;
  await app.call('POST', '/api/calendar/generate', { plan_hash: pv.plan_hash }, cookie);
}
const version = (app: TestApp, id: string) => app.one('SELECT version FROM features WHERE id = ?', id).version;
const phases = async (app: TestApp, cookie: string | null, id: string) => (await app.call('GET', `/api/features/${id}/phases`, undefined, cookie)).body;

describe('phases API', () => {
  test('baseline is fixed when the release plan is approved; bugs get none; a sprint move keeps it; re-baseline needs a reason', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    await calendar(app, pm);
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const s82 = app.one("SELECT * FROM sprints WHERE code = '8.2'");
    const t = (await app.call('POST', '/api/features', { title: 'План' }, pm)).body.id;
    const bug = (await app.call('POST', '/api/features', { title: 'Баг', task_kind: 'bug' }, pm)).body.id;
    await app.call('PATCH', `/api/features/${t}/schedule`, { sprint_id: s81.id, version: version(app, t) }, pm);
    await app.call('PATCH', `/api/features/${bug}/schedule`, { sprint_id: s81.id, version: version(app, bug) }, pm);
    let tl = (await phases(app, pm, t)).timeline;
    assert.equal(tl.agreed, false, 'in a sprint, not agreed yet');
    assert.deepEqual(ph(tl, 'dev').plan, { start: s81.start_date, end: s81.end_date });
    const rel = app.one('SELECT * FROM releases WHERE id = ?', s81.release_id);
    assert.equal((await app.call('POST', `/api/releases/${rel.id}/approve`, { version: rel.version, approved: true }, pm)).status, 200);
    tl = (await phases(app, pm, t)).timeline;
    assert.equal(tl.agreed, true);
    assert.deepEqual(ph(tl, 'dev').baseline, { start: s81.start_date, end: s81.end_date });
    assert.equal((await phases(app, pm, bug)).timeline.agreed, false, 'bugs are not agreed — they simply appear in the plan');
    // move to 8.2 (same release): plan follows the sprint, baseline stays
    assert.equal((await app.call('PATCH', `/api/features/${t}/schedule`, { sprint_id: s82.id, version: version(app, t) }, pm)).status, 200);
    tl = (await phases(app, pm, t)).timeline;
    assert.deepEqual(ph(tl, 'dev').plan, { start: s82.start_date, end: s82.end_date });
    assert.deepEqual(ph(tl, 'dev').baseline, { start: s81.start_date, end: s81.end_date });
    // explicit revision
    assert.equal((await app.call('POST', `/api/features/${t}/baseline`, {}, pm)).status, 400);
    assert.equal((await app.call('POST', `/api/features/${t}/baseline`, { reason: 'Перенос согласован с бизнесом' }, pm)).body.revision, 2);
    const all = await phases(app, pm, t);
    assert.deepEqual(all.baselines.map((b: any) => b.revision), [1, 2], 'every revision is kept');
    assert.deepEqual(ph(all.timeline, 'dev').baseline, { start: s82.start_date, end: s82.end_date });
    assert.equal(app.one('SELECT baseline_production_date FROM features WHERE id = ?', t).baseline_production_date, s81.production_due, 'the first promise (analytics) is never moved');
  });

  test('product department confirms transitions: dev → QA → complete; facts can be corrected with a reason; forecast needs a reason', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const prodLead = await app.user('prod@test.io', 'department_lead', ['dep_product']);
    await calendar(app, pm);
    const s81 = app.one("SELECT * FROM sprints WHERE code = '8.1'");
    const t = (await app.call('POST', '/api/features', { title: 'Этапы', visibility: 'internal' }, pm)).body.id;
    await app.call('PATCH', `/api/features/${t}/schedule`, { sprint_id: s81.id, version: version(app, t) }, pm);
    assert.equal((await app.call('POST', `/api/features/${t}/phase`, { phase: 'dev' }, lead)).status, 403, 'a sales lead cannot');
    assert.equal((await app.call('POST', `/api/features/${t}/phase`, { phase: 'dev', at: '2099-01-01' }, prodLead)).status, 400, 'no future facts');
    const r1 = await app.call('POST', `/api/features/${t}/phase`, { phase: 'dev', at: '2026-10-07' }, prodLead);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal((await app.call('POST', `/api/features/${t}/phase`, { phase: 'qa', at: '2026-10-12' }, pm)).status, 200);
    const qa = app.one("SELECT id FROM stages WHERE phase = 'qa'").id;
    assert.equal(app.one('SELECT stage_id FROM features WHERE id = ?', t).stage_id, qa, 'the card stage follows the phase');
    let p = await phases(app, lead, t);
    assert.equal(ph(p.timeline, 'dev').state, 'done');
    assert.deepEqual(ph(p.timeline, 'dev').fact, { start: '2026-10-07', end: '2026-10-12' });
    assert.equal(p.timeline.current, 'qa');
    // correction of a fact date: reason required, original kept, audited as an override
    const ev = p.events.find((e: any) => e.phase === 'dev' && e.kind === 'done');
    assert.equal((await app.call('PATCH', `/api/phase-events/${ev.id}`, { at: '2026-10-11' }, pm)).status, 400);
    assert.equal((await app.call('PATCH', `/api/phase-events/${ev.id}`, { at: '2026-10-11', reason: 'Внесли с опозданием' }, pm)).status, 200);
    p = await phases(app, pm, t);
    assert.equal(p.events.find((e: any) => e.id === ev.id).original_at, '2026-10-12');
    assert.equal(ph(p.timeline, 'dev').fact.end, '2026-10-11');
    assert.ok(app.one("SELECT is_override FROM audit_log WHERE entity_id = ? AND action = 'phase_fact_corrected'", t).is_override);
    // forecast
    assert.equal((await app.call('PUT', `/api/features/${t}/phase-forecast`, { phase: 'qa', end_date: '2026-10-31' }, pm)).status, 400);
    assert.equal((await app.call('PUT', `/api/features/${t}/phase-forecast`, { phase: 'qa', end_date: '2026-10-31', reason: 'Регресс по выплатам' }, pm)).status, 200);
    assert.equal(ph((await phases(app, pm, t)).timeline, 'qa').forecast_reason, 'Регресс по выплатам');
    // release done
    assert.equal((await app.call('POST', `/api/features/${t}/phase`, { phase: 'release', at: '2026-10-13' }, pm)).status, 200);
    assert.equal((await app.call('POST', `/api/features/${t}/phase`, { phase: 'complete', at: '2026-10-13' }, pm)).status, 200);
    p = await phases(app, pm, t);
    assert.equal(p.timeline.release.fact, '2026-10-13');
    assert.equal(ph(p.timeline, 'qa').fact.end, '2026-10-13');
    assert.ok(app.many("SELECT 1 AS x FROM audit_log WHERE entity_id = ? AND action = 'phase_changed'", t).length >= 4);
  });

  test('visibility: hidden tasks 404 for others; guests see the timeline of a public task but not who confirmed what', async () => {
    const app = await setup();
    const pm = await app.user('pm@test.io', 'product');
    const lead = await app.user('lead@test.io', 'department_lead', ['dep_sales']);
    const hidden = (await app.call('POST', '/api/features', { title: 'Скрытая', is_product_internal: true }, pm)).body.id;
    assert.equal((await app.call('GET', `/api/features/${hidden}/phases`, undefined, lead)).status, 404);
    const pub = (await app.call('POST', '/api/features', { title: 'Публичная', visibility: 'public' }, pm)).body.id;
    await app.call('POST', `/api/features/${pub}/phase`, { phase: 'design' }, pm);
    const g = await phases(app, null, pub);
    assert.equal(ph(g.timeline, 'design').state, 'active');
    assert.deepEqual(g.events, []);
    assert.equal(g.can_confirm, false);
  });
});

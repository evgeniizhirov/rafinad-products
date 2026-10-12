import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCsv, toCsv } from '../worker/domain/csv';
import { cyclePathIfAdded, findCycle } from '../worker/domain/graph';
import { buildPlan, type PlannerFeature, type PlannerInput } from '../worker/domain/planner';
import { compareByPriority, computePriority } from '../worker/domain/priority';
import { normalizeTitle, parseDate, parseHours, sanitizeCell, similarity } from '../worker/domain/text';

describe('priority score', () => {
  const depts = new Map([
    ['a', { id: 'a', weight: 1, isActive: true, isProduct: true }],
    ['b', { id: 'b', weight: 2, isActive: true, isProduct: false }],
    ['c', { id: 'c', weight: 1, isActive: false, isProduct: false }],
  ]);

  test('weighted average over departments that voted', () => {
    const r = computePriority([{ departmentId: 'a', score: 5 }, { departmentId: 'b', score: 2 }], depts);
    assert.equal(r.score, 3); // (5*1 + 2*2) / 3
    assert.equal(r.voters, 2);
    assert.equal(r.productScore, 5);
  });

  test('no vote is not a score of 1; inactive departments are ignored', () => {
    assert.equal(computePriority([], depts).score, null);
    const r = computePriority([{ departmentId: 'b', score: 4 }, { departmentId: 'c', score: 1 }], depts);
    assert.equal(r.score, 4);
    assert.equal(r.voters, 1);
  });

  test('ties: Product score, then created_at, then number', () => {
    const base = { score: 4, createdAt: '2026-01-01', number: 5 };
    const list = [
      { ...base, productScore: 3, number: 1 },
      { ...base, productScore: 5, number: 2 },
      { ...base, productScore: null, number: 3 },
      { ...base, productScore: 5, number: 4, createdAt: '2025-12-01' },
      { score: null, productScore: null, createdAt: '2020-01-01', number: 6 },
    ];
    const sorted = list.slice().sort(compareByPriority).map((x) => x.number);
    assert.deepEqual(sorted, [4, 2, 1, 3, 6]);
  });
});

describe('dependency graph', () => {
  test('detects cycles before adding an edge', () => {
    const edges: [string, string][] = [['a', 'b'], ['b', 'c']];
    assert.deepEqual(cyclePathIfAdded(edges, 'c', 'a'), ['c', 'a', 'b', 'c']);
    assert.equal(cyclePathIfAdded(edges, 'a', 'c'), null);
    assert.ok(cyclePathIfAdded(edges, 'a', 'a'));
  });
  test('finds a cycle in a batch', () => {
    assert.equal(findCycle([['a', 'b'], ['b', 'c']]), null);
    assert.ok(findCycle([['a', 'b'], ['b', 'c'], ['c', 'a']]));
  });
});

describe('planner', () => {
  const periods = [
    { id: 'p1', name: 'Январь', startDate: '2027-01-01', endDate: '2027-01-31' },
    { id: 'p2', name: 'Февраль', startDate: '2027-02-01', endDate: '2027-02-28' },
    { id: 'p3', name: 'Март', startDate: '2027-03-01', endDate: '2027-03-31' },
  ];
  const teams = [{ id: 'be', name: 'Backend' }, { id: 'fe', name: 'Frontend' }];
  const cap = (be: number, fe: number) => new Map([['p1|be', be], ['p1|fe', fe], ['p2|be', be], ['p2|fe', fe], ['p3|be', be], ['p3|fe', fe]]);
  const f = (n: number, over: Partial<PlannerFeature> = {}): PlannerFeature => ({
    id: `f${n}`, number: n, title: `F${n}`, semantic: 'ready', statusName: 'Готова', estimates: { be: 10 }, periodId: null, fixed: false,
    score: 3, productScore: null, createdAt: `2026-01-${String(n).padStart(2, '0')}`, ...over,
  });
  const input = (features: PlannerFeature[], blocks: [string, string][] = [], capacities = cap(20, 20)): PlannerInput => ({
    periods, teams, capacities, features, blocks, params: { startPeriodId: 'p1', horizon: 3 },
  });

  test('places by priority into the earliest period with enough hours of ALL teams', () => {
    const r = buildPlan(input([f(1, { score: 2 }), f(2, { score: 5, estimates: { be: 15, fe: 5 } }), f(3, { score: 4, estimates: { be: 10 } })]));
    const where = Object.fromEntries(r.placements.map((p) => [p.featureId, p.periodId]));
    assert.deepEqual(where, { f2: 'p1', f3: 'p2', f1: 'p2' });
  });

  test('excludes by status and missing estimates with reasons', () => {
    const r = buildPlan(input([f(1, { semantic: 'done' }), f(2, { semantic: 'blocked' }), f(3, { semantic: 'analysis' }), f(4, { estimates: {} }), f(5, { semantic: 'postponed' })]));
    assert.equal(r.placements.length, 0);
    const codes = Object.fromEntries(r.unplaced.map((u) => [u.featureId, u.code]));
    assert.equal(codes.f2, 'status');
    assert.equal(codes.f4, 'not_estimated');
    assert.match(r.unplaced.find((u) => u.featureId === 'f4')!.reasons[0], /не оценена/);
  });

  test('explains capacity shortage per team', () => {
    const r = buildPlan(input([f(1, { estimates: { be: 15 } }), f(2, { estimates: { be: 15 } }), f(3, { estimates: { be: 15 } }), f(4, { estimates: { be: 15, fe: 30 } })]));
    const u = r.unplaced.find((x) => x.featureId === 'f4')!;
    assert.equal(u.code, 'too_big');
    const r2 = buildPlan(input([f(1, { estimates: { be: 15 } }), f(2, { estimates: { be: 15 } }), f(3, { estimates: { be: 15 } }), f(4, { estimates: { be: 15 } })]));
    const u2 = r2.unplaced.find((x) => x.featureId === 'f4')!;
    assert.equal(u2.code, 'capacity');
    assert.match(u2.reasons[0], /Не хватает 10 ч Backend/);
  });

  test('blocking task must be done or planned in an EARLIER period', () => {
    // f1 has lower priority but blocks f2
    const r = buildPlan(input([f(1, { score: 1 }), f(2, { score: 5 })], [['f1', 'f2']]));
    const where = Object.fromEntries(r.placements.map((p) => [p.featureId, p.periodId]));
    assert.equal(where.f1, 'p1');
    assert.equal(where.f2, 'p2');
    const r2 = buildPlan(input([f(1, { semantic: 'analysis' }), f(2)], [['f1', 'f2']]));
    assert.equal(r2.unplaced.find((u) => u.featureId === 'f2')!.code, 'dependency');
    const r3 = buildPlan(input([f(1, { semantic: 'done' }), f(2)], [['f1', 'f2']]));
    assert.equal(r3.placements.find((p) => p.featureId === 'f2')!.periodId, 'p1');
  });

  test('fixed placements are kept and consume capacity', () => {
    const r = buildPlan(input([f(1, { fixed: true, periodId: 'p1', estimates: { be: 20 } }), f(2, { score: 5 })]));
    assert.deepEqual(r.placements.map((p) => [p.featureId, p.periodId, p.kind]), [['f1', 'p1', 'fixed'], ['f2', 'p2', 'proposed']]);
  });

  test('deterministic: same input → same output regardless of input order', () => {
    const feats = Array.from({ length: 12 }, (_, i) => f(i + 1, { score: (i * 7) % 5 + 1, estimates: { be: 5 + (i % 3) * 4, fe: i % 2 ? 6 : 0 } }));
    const a = buildPlan(input(feats, [['f3', 'f9']]));
    const b = buildPlan(input(feats.slice().reverse(), [['f3', 'f9']]));
    assert.deepEqual(a, b);
  });
});

describe('text & csv', () => {
  test('normalisation and similarity', () => {
    assert.equal(normalizeTitle('  Постбеки — в реальном   времени!'), 'постбеки в реальном времени');
    assert.ok(similarity('Постбеки в реальном времени', 'Постбэки в реальном времени') > 0.7);
    assert.ok(similarity('Постбеки в реальном времени', 'Тёмная тема') < 0.3);
  });
  test('untrusted cells are sanitised but kept as text', () => {
    assert.equal(sanitizeCell('<script>alert(1)</script>\u0000'), '<script>alert(1)</script>');
    assert.equal(sanitizeCell('=HYPERLINK("http://x")'), '=HYPERLINK("http://x")');
    assert.equal(sanitizeCell('x'.repeat(50), 10).length, 10);
  });
  test('hours and dates', () => {
    assert.deepEqual(parseHours('12,5'), { value: 12.5 });
    assert.equal(parseHours('abc').value, null);
    assert.ok(parseHours('abc').error);
    assert.equal(parseHours('').value, null);
    assert.equal(parseDate('15.09.2026'), '2026-09-15');
    assert.equal(parseDate('2026-02-30'), null);
  });
  test('CSV round trip with quotes, newlines and ; separator', () => {
    const rows = [['a', 'b,c', 'd "e"'], ['1', 'line\nbreak', '']];
    assert.deepEqual(parseCsv(toCsv(rows)).slice(0, 2), [rows[0], ['1', 'line\nbreak', '']]);
    assert.deepEqual(parseCsv('x;y\n1;2'), [['x', 'y'], ['1', '2']]);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCsv, toCsv } from '../worker/domain/csv';
import { cyclePathIfAdded, findCycle } from '../worker/domain/graph';
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

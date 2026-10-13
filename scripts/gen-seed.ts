// Generates seed/seed.sql (demo data) from scripts/seed-data.ts.
// Usage: npx tsx scripts/gen-seed.ts   → then `wrangler d1 execute DB --local|--remote --file seed/seed.sql`
// Demo users are created WITHOUT passwords: an administrator issues invitations / temporary passwords.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './seed-data';

const q = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
};
const ins = (table: string, row: Record<string, unknown>) =>
  `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')});`;

export function seedSql(): string[] {
  const out: string[] = [];
  const T0 = '2026-06-01T08:00:00Z';
  for (const [id, name, color] of S.categories) out.push(ins('categories', { id, name, color, sort_order: out.length }));
  S.departments.forEach(([id, code, name, weight, isProduct], i) =>
    out.push(ins('departments', { id, code, name, weight, is_product: isProduct, sort_order: i, created_at: T0, updated_at: T0 })));
  S.teams.forEach(([id, code, name, color], i) => out.push(ins('resource_teams', { id, code, name, color, sort_order: i, created_at: T0, updated_at: T0 })));
  for (const [id, email, name, role, deps] of S.users) {
    out.push(ins('users', { id, email, name, role_code: role, password_hash: null, must_change_password: 1, is_active: 1, created_at: T0, updated_at: T0 }));
    for (const d of deps) out.push(ins('department_memberships', { user_id: id, department_id: d }));
  }
  for (const [id, number, title, description, cat, status, vis, owner, start, end] of S.epics) {
    out.push(ins('epics', { id, number, title, description, category_id: cat, status_id: status, visibility: vis, owner_name: owner, start_date: start, end_date: end, created_at: T0, updated_at: T0, created_by: 'u_pm' }));
  }
  const fid = (n: number) => `feat_${String(n).padStart(3, '0')}`;
  for (const f of S.features) {
    out.push(ins('features', {
      id: fid(f.n), number: f.n, external_ref: f.ext ?? null, title: f.title, description: f.desc, category_id: f.cat, epic_id: f.epic ?? null,
      status_id: f.status, stage_id: f.stage ?? null, author_name: f.author ?? null, assignee_name: f.assignee ?? null, requested_at: f.requested,
      closed_at: f.closed ?? null, visibility: f.vis ?? 'internal',
      created_at: f.created, updated_at: f.created, created_by: 'u_pm', updated_by: 'u_pm',
    }));
    for (const [team, hours] of Object.entries(f.est ?? {})) {
      out.push(ins('feature_estimates', { feature_id: fid(f.n), team_id: team, hours, is_manual: 1, updated_at: f.created, updated_by: 'u_pm' }));
    }
    const voters: Record<string, string> = { dep_product: 'u_pm', dep_sales: 'u_sales', dep_affiliates: 'u_aff', dep_support: 'u_aff', dep_finance: 'u_fin', dep_antifraud: 'u_af' };
    for (const [dep, score] of Object.entries(f.votes ?? {})) {
      out.push(ins('department_votes', { feature_id: fid(f.n), department_id: dep, score, voted_by: voters[dep], voted_at: '2026-10-01T09:00:00Z' }));
    }
    for (const t of f.tags ?? []) out.push(ins('feature_tags', { feature_id: fid(f.n), tag: t }));
  }
  S.blocks.forEach(([a, b], i) => out.push(ins('feature_relations', { id: `rel_b${i + 1}`, type: 'blocks', from_id: fid(a), to_id: fid(b), created_at: T0, created_by: 'u_pm' })));
  S.related.forEach(([a, b], i) => out.push(ins('feature_relations', { id: `rel_r${i + 1}`, type: 'related_to', from_id: fid(a), to_id: fid(b), created_at: T0, created_by: 'u_pm' })));
  for (const [id, name, version, description, status, planned, actual, approved, vis, feats] of S.releases) {
    out.push(ins('releases', {
      id, name, version_label: version, description, status_id: status, planned_date: planned, actual_date: actual,
      approved_at: approved ? '2026-10-01T10:00:00Z' : null, approved_by: approved ? 'u_pm' : null, visibility: vis, created_at: T0, updated_at: T0, created_by: 'u_pm',
    }));
    for (const n of feats) out.push(ins('release_features', { release_id: id, feature_id: fid(n), added_at: T0, added_by: 'u_pm' }));
  }
  S.comments.forEach(([n, uid, name, body, at], i) => out.push(ins('comments', { id: `cm_${i + 1}`, feature_id: fid(n), author_id: uid, author_name: name, body, created_at: at })));
  out.push(ins('audit_log', { at: '2026-10-12T00:00:00Z', actor_id: null, actor_name: 'Система', entity_type: 'system', entity_id: 'seed', action: 'demo_data_loaded', changes: null, reason: 'Демонстрационные данные' }));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'seed.sql');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `-- Generated by scripts/gen-seed.ts — demo data for Rafinad Product Roadmap\n${seedSql().join('\n')}\n`);
  console.log(`Wrote ${file}`);
}

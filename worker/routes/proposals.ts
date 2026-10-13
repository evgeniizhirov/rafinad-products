// «Предложения» (vNext ТЗ §1.2): business needs raised by any signed-in employee.
//   read / create / comment — every signed-in employee (guests: 401; all proposals are visible to all employees)
//   vote — only for a department the user belongs to (admin: any department, with a reason, audited)
//   decisions, linking tasks, merging — product / admin
// Linked tasks follow the task ACL: hidden Product tasks never appear for others, not even in the forecast or counters.
import { z } from 'zod';
import { computePriority } from '../domain/priority';
import { canTransition, EDITABLE_BY_AUTHOR, PROPOSAL_STATUS_LABEL, PROPOSAL_STATUSES, proposalKey, REASON_REQUIRED, TRANSITIONS, type ProposalStatus } from '../domain/proposals';
import { perms, requirePerm, requireUser, type SessionUser } from '../lib/auth';
import { auditStmt, type Change } from '../lib/audit';
import { all, bool, first, guardVersion, newId, nowIso, parseJson, stmt, tx, type Row } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, readJson, type Ctx, type Router } from '../lib/http';
import { canSeeFeature, deptWeights, indexWorld, isProductInternal, loadWorld, sprintRef, statusDto, viewerOf, type Indexes, type Viewer, type World } from '../lib/world';
import type { D1Database } from '../env';

const text = (max: number) => z.string().trim().max(max);
const editSchema = {
  title: text(300).min(1),
  description: text(20000),
  expected_result: text(5000).nullable(),
  department_id: z.string().nullable(),
};

async function resolveProposal(ctx: Ctx, ref: string): Promise<Row> {
  const m = /^(?:p-)?(\d+)$/i.exec(ref);
  const p = m ? await first(ctx.env.DB, 'SELECT * FROM proposals WHERE number = ?', Number(m[1])) : await first(ctx.env.DB, 'SELECT * FROM proposals WHERE id = ?', ref);
  if (!p) throw notFound('Предложение не найдено');
  return p;
}

async function checkDepartment(db: D1Database, id: string | null | undefined) {
  if (!id) return;
  const d = await first(db, 'SELECT is_active FROM departments WHERE id = ?', id);
  if (!d || !bool(d.is_active)) throw badRequest('Отдел не найден или отключён');
}

/** linked tasks as the viewer may see them + a business forecast built only from those tasks */
function deliveryOf(featureIds: string[], viewer: Viewer, w: World, idx: Indexes) {
  const tasks = featureIds.map((id) => idx.feature.get(id)).filter((f): f is Row => !!f && !f.merged_into_id && canSeeFeature(viewer, f));
  const sem = (f: Row) => idx.status.get(f.status_id)?.semantic;
  const open = tasks.filter((f) => !['done', 'cancelled'].includes(sem(f)));
  const dates = open.map((f) => f.planned_production_date ?? (f.sprint_id ? idx.sprint.get(f.sprint_id)?.production_due : null) ?? f.planned_end).filter(Boolean) as string[];
  const releases = [...new Set(open.map((f) => idx.releaseOf.get(f.id)).filter(Boolean) as string[])]
    .map((id) => idx.release.get(id))
    .filter((r): r is Row => !!r && (viewer === 'editor' || r.visibility !== 'draft'))
    .map((r) => ({ id: r.id, name: r.name, planned_date: r.planned_date }));
  return {
    tasks: tasks.map((f) => {
      const s = f.sprint_id ? sprintRef(idx.sprint.get(f.sprint_id), viewer, idx) : null;
      return {
        id: f.id, key: `RF-${f.number}`, title: f.title, status: statusDto(idx.status.get(f.status_id)), task_kind: f.task_kind ?? 'planned',
        sprint: s ? { id: s.id, code: s.code } : null, planned_production_date: f.planned_production_date ?? null, closed_at: f.closed_at ?? null,
        ...(viewer === 'editor' && isProductInternal(f) ? { is_product_internal: true } : {}),
      };
    }),
    forecast: { production_date: dates.sort().at(-1) ?? null, releases },
    done: tasks.filter((f) => sem(f) === 'done').length,
    total: tasks.filter((f) => sem(f) !== 'cancelled').length,
    /** hint for product: every linked task is done → «Реализовано» can be confirmed (never set automatically) */
    all_done: tasks.length > 0 && tasks.every((f) => ['done', 'cancelled'].includes(sem(f))) && tasks.some((f) => sem(f) === 'done'),
  };
}

function summaryDto(p: Row, votes: Row[], featureIds: string[], viewer: Viewer, w: World, idx: Indexes, comments: number) {
  const weights = deptWeights(w);
  const pr = computePriority(votes.map((v) => ({ departmentId: v.department_id, score: v.score, votedAt: v.voted_at })), weights);
  const dep = p.department_id ? w.departments.find((d) => d.id === p.department_id) : undefined;
  const delivery = deliveryOf(featureIds, viewer, w, idx);
  return {
    id: p.id, number: p.number, key: proposalKey(p.number), title: p.title,
    excerpt: (p.description || '').slice(0, 220),
    status: { code: p.status, name: PROPOSAL_STATUS_LABEL[p.status as ProposalStatus] ?? p.status },
    author: { id: p.author_id, name: p.author_name },
    department: dep ? { id: dep.id, name: dep.name } : null,
    priority: { score: pr.score, voters: pr.voters },
    decision_reason: p.decision_reason ?? null, decided_at: p.decided_at ?? null, implemented_at: p.implemented_at ?? null,
    merged_into: p.merged_into_id ?? null,
    created_at: p.created_at, updated_at: p.updated_at, version: p.version,
    comment_count: comments,
    delivery: { done: delivery.done, total: delivery.total, forecast: delivery.forecast, all_done: delivery.all_done },
  };
}

async function loadSide(db: D1Database) {
  const [votes, links, comments] = await Promise.all([
    all(db, 'SELECT * FROM proposal_votes'),
    all(db, 'SELECT proposal_id, feature_id FROM proposal_features'),
    all(db, 'SELECT proposal_id, COUNT(*) AS n FROM proposal_comments GROUP BY proposal_id'),
  ]);
  const group = <T extends Row>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.proposal_id) ?? m.set(r.proposal_id, []).get(r.proposal_id)!).push(r);
    return m;
  };
  return { votes: group(votes), links: group(links), comments: new Map(comments.map((c) => [c.proposal_id, Number(c.n)])) };
}

/** audit entries of a proposal, without ids of tasks the viewer may not see */
async function historyOf(db: D1Database, p: Row, viewer: Viewer, idx: Indexes) {
  const rows = await all(db, `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity_type = 'proposal' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 200`, p.id);
  return rows.flatMap((h: Row): Row[] => {
    const changes = parseJson<Change[]>(h.changes, []);
    const taskChange = changes.find((c) => c.field === 'task');
    if (taskChange) {
      const fid = String(taskChange.new ?? taskChange.old ?? '');
      const f = idx.feature.get(fid);
      if (!f || !canSeeFeature(viewer, f)) return [];
      return [{ ...h, changes: [{ field: 'task', old: taskChange.old ? `RF-${f.number}` : null, new: taskChange.new ? `RF-${f.number}` : null }] }];
    }
    return [{ ...h, changes }];
  }).map((h) => ({ id: h.id, at: h.at, actor: h.actor_name ?? h.user_name, action: h.action, changes: h.changes, reason: h.reason, is_override: !!h.is_override }));
}

/** accepted → planned for the proposals of a task that now has a sprint (statements + audit) */
export async function autoPlanStatements(db: D1Database, user: SessionUser, featureId: string): Promise<D1PreparedStatementLike[]> {
  const rows = await all(db, `SELECT p.id FROM proposals p JOIN proposal_features pf ON pf.proposal_id = p.id
    WHERE pf.feature_id = ? AND p.status = 'accepted' AND p.merged_into_id IS NULL`, featureId);
  const now = nowIso();
  return rows.flatMap((r) => [
    stmt(db, `UPDATE proposals SET status = 'planned', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'accepted'`, now, r.id),
    auditStmt(db, user, 'proposal', r.id, 'status_auto', [{ field: 'status', old: 'accepted', new: 'planned' }], 'Связанная задача назначена в спринт'),
  ]);
}
type D1PreparedStatementLike = ReturnType<typeof stmt>;

export function registerProposalRoutes(r: Router) {
  r.get('/api/proposals', async (ctx) => {
    const user = requireUser(ctx);
    const viewer = viewerOf(user);
    const db = ctx.env.DB;
    const p = ctx.url.searchParams;
    const w = await loadWorld(db, viewer, { includeInternal: viewer === 'editor' });
    const idx = indexWorld(w);
    const side = await loadSide(db);
    let rows = await all(db, 'SELECT * FROM proposals ORDER BY number DESC');
    if (p.get('include_merged') !== '1') rows = rows.filter((x) => !x.merged_into_id);
    const q = (p.get('q') ?? '').trim().toLowerCase();
    if (q) rows = rows.filter((x) => `${proposalKey(x.number)} ${x.title} ${x.description} ${x.expected_result ?? ''} ${x.author_name}`.toLowerCase().includes(q));
    const statuses = (p.get('status') ?? '').split(',').filter(Boolean);
    if (statuses.length) rows = rows.filter((x) => statuses.includes(x.status));
    if (p.get('department')) rows = rows.filter((x) => (p.get('department') === 'none' ? !x.department_id : x.department_id === p.get('department')));
    if (p.get('author') === 'me') rows = rows.filter((x) => x.author_id === user.id);
    else if (p.get('author')) rows = rows.filter((x) => x.author_id === p.get('author'));
    if (p.get('from')) rows = rows.filter((x) => x.created_at.slice(0, 10) >= p.get('from')!);
    if (p.get('to')) rows = rows.filter((x) => x.created_at.slice(0, 10) <= p.get('to')!);
    const list = rows.map((x) => summaryDto(x, side.votes.get(x.id) ?? [], (side.links.get(x.id) ?? []).map((l) => l.feature_id), viewer, w, idx, side.comments.get(x.id) ?? 0));
    const sort = p.get('sort') ?? 'popular';
    if (sort === 'popular') list.sort((a, b) => (b.priority.score ?? -1) - (a.priority.score ?? -1) || b.priority.voters - a.priority.voters || b.number - a.number);
    else if (sort === 'updated') list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    else list.sort((a, b) => b.number - a.number);
    const counts = Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s, rows.filter((x) => x.status === s).length]));
    return json({ proposals: list, total: list.length, counts, statuses: PROPOSAL_STATUSES.map((s) => ({ code: s, name: PROPOSAL_STATUS_LABEL[s] })) });
  });

  r.get('/api/proposals/:id', async (ctx) => {
    const user = requireUser(ctx);
    const viewer = viewerOf(user);
    const db = ctx.env.DB;
    const p = await resolveProposal(ctx, ctx.params.id);
    const w = await loadWorld(db, viewer, { includeInternal: viewer === 'editor' });
    const idx = indexWorld(w);
    const votes = await all(db, 'SELECT v.*, u.name AS voter_name FROM proposal_votes v LEFT JOIN users u ON u.id = v.voted_by WHERE v.proposal_id = ?', p.id);
    const featureIds = (await all(db, 'SELECT feature_id FROM proposal_features WHERE proposal_id = ? ORDER BY created_at', p.id)).map((x) => x.feature_id as string);
    const comments = await all(db, 'SELECT * FROM proposal_comments WHERE proposal_id = ? ORDER BY created_at, id', p.id);
    const merged = await all(db, 'SELECT id, number, title, author_name, created_at FROM proposals WHERE merged_into_id = ? ORDER BY number', p.id);
    const target = p.merged_into_id ? await first(db, 'SELECT id, number, title FROM proposals WHERE id = ?', p.merged_into_id) : null;
    const dto = summaryDto(p, votes, featureIds, viewer, w, idx, comments.length);
    const delivery = deliveryOf(featureIds, viewer, w, idx);
    const isEditor = perms.editCatalog(user);
    const isAuthor = p.author_id === user.id;
    return json({
      proposal: {
        ...dto,
        description: p.description,
        expected_result: p.expected_result ?? null,
        votes: w.departments.filter((d) => bool(d.is_active)).map((d) => {
          const v = votes.find((x) => x.department_id === d.id);
          return { department_id: d.id, department: d.name, weight: Number(d.weight), score: v?.score ?? null, version: v?.version ?? null, voted_by: v?.voter_name ?? null, voted_at: v?.voted_at ?? null, can_vote: perms.voteFor(user, d.id) };
        }),
        tasks: delivery.tasks,
        delivery: { done: delivery.done, total: delivery.total, forecast: delivery.forecast, all_done: delivery.all_done },
        comments: comments.map((c) => ({ id: c.id, author_name: c.author_name, body: c.body, created_at: c.created_at, moved_from: c.moved_from ?? null })),
        merged_from: merged.map((m) => ({ id: m.id, key: proposalKey(m.number), title: m.title, author_name: m.author_name, created_at: m.created_at })),
        merged_into_ref: target ? { id: target.id, key: proposalKey(target.number), title: target.title } : null,
        history: await historyOf(db, p, viewer, idx),
        permissions: {
          edit: !p.merged_into_id && (isEditor || (isAuthor && EDITABLE_BY_AUTHOR.includes(p.status))),
          decide: !p.merged_into_id && isEditor,
          link: !p.merged_into_id && isEditor,
          merge: !p.merged_into_id && isEditor,
          override_vote: perms.overrideVote(user),
        },
        transitions: isEditor && !p.merged_into_id ? TRANSITIONS[p.status as ProposalStatus].map((s) => ({ code: s, name: PROPOSAL_STATUS_LABEL[s], reason_required: REASON_REQUIRED.includes(s) })) : [],
      },
    });
  });

  r.post('/api/proposals', async (ctx) => {
    const user = requireUser(ctx);
    const b = await readJson(ctx, z.object({ title: editSchema.title, description: editSchema.description.optional(), expected_result: editSchema.expected_result.optional(), department_id: editSchema.department_id.optional() }));
    const db = ctx.env.DB;
    await checkDepartment(db, b.department_id);
    const id = newId('prp');
    const now = nowIso();
    for (let attempt = 0; attempt < 3; attempt++) {
      const num = (await first<{ n: number }>(db, 'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM proposals'))?.n ?? 1;
      try {
        await tx(db, [
          stmt(db, `INSERT INTO proposals (id, number, title, description, expected_result, author_id, author_name, department_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, num, b.title, b.description ?? '', b.expected_result || null, user.id, user.name, b.department_id ?? null, now, now),
          auditStmt(db, user, 'proposal', id, 'created', [{ field: 'title', old: null, new: b.title }]),
        ]);
        return json({ id, number: num, key: proposalKey(num) }, 201);
      } catch (e) {
        if (attempt === 2 || !/UNIQUE/i.test(String((e as Error).message))) throw e;
      }
    }
    throw conflict('busy', 'Не удалось присвоить номер — повторите');
  });

  r.patch('/api/proposals/:id', async (ctx) => {
    const user = requireUser(ctx);
    const b = await readJson(ctx, z.object({
      title: editSchema.title.optional(), description: editSchema.description.optional(), expected_result: editSchema.expected_result.optional(),
      department_id: editSchema.department_id.optional(), version: z.number().int(),
    }));
    const p = await resolveProposal(ctx, ctx.params.id);
    if (p.merged_into_id) throw conflict('merged', 'Предложение объединено с другим — меняйте основное');
    const isEditor = perms.editCatalog(user);
    if (!isEditor && !(p.author_id === user.id && EDITABLE_BY_AUTHOR.includes(p.status))) {
      throw forbidden(p.author_id === user.id ? 'После решения продуктовой команды текст предложения меняет только она' : 'Менять предложение может автор или продуктовая команда');
    }
    const db = ctx.env.DB;
    if (b.department_id !== undefined) await checkDepartment(db, b.department_id);
    const changes: Change[] = [];
    for (const k of ['title', 'description', 'expected_result', 'department_id'] as const) {
      const v = (b as Record<string, unknown>)[k];
      if (v === undefined) continue;
      const next = k === 'expected_result' || k === 'department_id' ? (v || null) : v;
      if ((p[k] ?? null) !== (next ?? null)) changes.push({ field: k, old: p[k] ?? null, new: next });
    }
    if (!changes.length) return json({ ok: true, unchanged: true, version: p.version });
    await tx(db, [
      guardVersion(db, 'proposals', p.id, b.version),
      stmt(db, `UPDATE proposals SET ${changes.map((c) => `${c.field} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`, ...changes.map((c) => c.new), nowIso(), p.id),
      auditStmt(db, user, 'proposal', p.id, 'updated', changes),
    ], 'Предложение изменил другой пользователь. Обновите страницу.');
    return json({ ok: true, version: p.version + 1 });
  });

  /** product decision: the status model lives in domain/proposals.ts; reasons for postponing / rejecting are mandatory */
  r.post('/api/proposals/:id/status', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog, 'Решение по предложению принимает продуктовая команда');
    const b = await readJson(ctx, z.object({ status: z.enum(PROPOSAL_STATUSES), reason: text(2000).optional(), version: z.number().int() }));
    const p = await resolveProposal(ctx, ctx.params.id);
    if (p.merged_into_id) throw conflict('merged', 'Предложение объединено с другим');
    if (p.status === b.status) return json({ ok: true, unchanged: true });
    if (!canTransition(p.status, b.status)) {
      throw badRequest(`Из статуса «${PROPOSAL_STATUS_LABEL[p.status as ProposalStatus]}» нельзя перейти в «${PROPOSAL_STATUS_LABEL[b.status]}»`);
    }
    if (REASON_REQUIRED.includes(b.status) && !b.reason) throw badRequest(`Для статуса «${PROPOSAL_STATUS_LABEL[b.status]}» укажите причину — её увидит автор`);
    const db = ctx.env.DB;
    const now = nowIso();
    const decision = ['accepted', 'postponed', 'rejected'].includes(b.status);
    await tx(db, [
      guardVersion(db, 'proposals', p.id, b.version),
      stmt(db, `UPDATE proposals SET status = ?, decision_reason = CASE WHEN ? THEN ? ELSE decision_reason END,
          decided_at = CASE WHEN ? THEN ? ELSE decided_at END, decided_by = CASE WHEN ? THEN ? ELSE decided_by END,
          implemented_at = CASE WHEN ? = 'implemented' THEN ? WHEN ? = 'planned' THEN NULL ELSE implemented_at END,
          updated_at = ?, version = version + 1 WHERE id = ?`,
        b.status, decision ? 1 : 0, b.reason ?? null, decision ? 1 : 0, now, decision ? 1 : 0, user.id, b.status, now.slice(0, 10), b.status, now, p.id),
      auditStmt(db, user, 'proposal', p.id, 'status', [{ field: 'status', old: p.status, new: b.status }], b.reason ?? null),
    ], 'Предложение изменил другой пользователь. Обновите страницу.');
    return json({ ok: true });
  });

  r.put('/api/proposals/:id/votes/:departmentId', async (ctx) => {
    const user = requireUser(ctx);
    const b = await readJson(ctx, z.object({ score: z.number().int().min(1).max(5).nullable(), expected_version: z.number().int().nullable(), reason: text(500).optional() }));
    const db = ctx.env.DB;
    const deptId = ctx.params.departmentId;
    const dept = await first(db, 'SELECT * FROM departments WHERE id = ?', deptId);
    if (!dept || !bool(dept.is_active)) throw badRequest('Отдел не найден или отключён');
    const own = perms.voteFor(user, deptId);
    if (!own) {
      if (!perms.overrideVote(user)) throw forbidden(`Вы не можете голосовать от имени отдела «${dept.name}»`);
      if (!b.reason) throw badRequest('Изменение оценки за другой отдел — административное действие: укажите причину');
    }
    const p = await resolveProposal(ctx, ctx.params.id);
    if (p.merged_into_id) throw conflict('merged', 'Предложение объединено — голосуйте за основное');
    const cur = await first(db, 'SELECT * FROM proposal_votes WHERE proposal_id = ? AND department_id = ?', p.id, deptId);
    if ((cur?.version ?? null) !== b.expected_version) {
      throw conflict('version_conflict', 'Оценку этого отдела уже изменили. Обновите данные.', { current: cur ? { score: cur.score, version: cur.version } : null });
    }
    if ((cur?.score ?? null) === b.score) return json({ ok: true, unchanged: true });
    const now = nowIso();
    await tx(db, [
      cur
        ? stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'pvote' WHERE NOT EXISTS (SELECT 1 FROM proposal_votes WHERE proposal_id = ? AND department_id = ? AND version = ?)`, p.id, deptId, cur.version)
        : stmt(db, `INSERT INTO _guard (v, tag) SELECT 1, 'pvote' WHERE EXISTS (SELECT 1 FROM proposal_votes WHERE proposal_id = ? AND department_id = ?)`, p.id, deptId),
      b.score === null
        ? stmt(db, 'DELETE FROM proposal_votes WHERE proposal_id = ? AND department_id = ?', p.id, deptId)
        : cur
          ? stmt(db, 'UPDATE proposal_votes SET score = ?, voted_by = ?, voted_at = ?, version = version + 1 WHERE proposal_id = ? AND department_id = ?', b.score, user.id, now, p.id, deptId)
          : stmt(db, 'INSERT INTO proposal_votes (proposal_id, department_id, score, voted_by, voted_at) VALUES (?, ?, ?, ?, ?)', p.id, deptId, b.score, user.id, now),
      auditStmt(db, user, 'proposal', p.id, own ? 'vote' : 'vote_admin_override', [{ field: `vote:${dept.name}`, old: cur?.score ?? null, new: b.score }], b.reason ?? null, !own),
    ], 'Оценку этого отдела уже изменили. Обновите данные.');
    return json({ ok: true });
  });

  r.post('/api/proposals/:id/comments', async (ctx) => {
    const user = requireUser(ctx);
    const b = await readJson(ctx, z.object({ body: text(5000).min(1) }));
    const p = await resolveProposal(ctx, ctx.params.id);
    const db = ctx.env.DB;
    const id = newId('pc');
    await tx(db, [
      stmt(db, 'INSERT INTO proposal_comments (id, proposal_id, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, p.id, user.id, user.name, b.body, nowIso()),
      auditStmt(db, user, 'proposal', p.id, 'comment_added', [{ field: 'comment', old: null, new: b.body.slice(0, 200) }]),
    ]);
    return json({ id }, 201);
  });

  /** link a task (many-to-many). A task that already has a sprint moves an accepted proposal to «Запланировано». */
  r.post('/api/proposals/:id/features', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog, 'Связывать предложения с задачами может продуктовая команда');
    const b = await readJson(ctx, z.object({ feature_id: z.string().min(1).max(120) }));
    const p = await resolveProposal(ctx, ctx.params.id);
    if (p.merged_into_id) throw conflict('merged', 'Предложение объединено — свяжите задачу с основным');
    const db = ctx.env.DB;
    const m = /^(?:rf-)?(\d+)$/i.exec(b.feature_id);
    const f = m ? await first(db, 'SELECT * FROM features WHERE number = ?', Number(m[1])) : await first(db, 'SELECT * FROM features WHERE id = ?', b.feature_id);
    if (!f) throw notFound('Задача не найдена');
    if (f.merged_into_id) throw conflict('merged', 'Задача объединена с другой — выберите основную');
    if (await first(db, 'SELECT 1 FROM proposal_features WHERE proposal_id = ? AND feature_id = ?', p.id, f.id)) return json({ ok: true, unchanged: true });
    const st = [
      stmt(db, 'INSERT INTO proposal_features (proposal_id, feature_id, created_at, created_by) VALUES (?, ?, ?, ?)', p.id, f.id, nowIso(), user.id),
      auditStmt(db, user, 'proposal', p.id, 'task_linked', [{ field: 'task', old: null, new: f.id }]),
      auditStmt(db, user, 'feature', f.id, 'proposal_linked', [{ field: 'proposal', old: null, new: proposalKey(p.number) }]),
    ];
    if (f.sprint_id && p.status === 'accepted') {
      st.push(stmt(db, `UPDATE proposals SET status = 'planned', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'accepted'`, nowIso(), p.id));
      st.push(auditStmt(db, user, 'proposal', p.id, 'status_auto', [{ field: 'status', old: 'accepted', new: 'planned' }], 'Связанная задача уже назначена в спринт'));
    }
    await tx(db, st);
    return json({ ok: true }, 201);
  });

  r.delete('/api/proposals/:id/features/:featureId', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog);
    const p = await resolveProposal(ctx, ctx.params.id);
    const db = ctx.env.DB;
    const link = await first(db, 'SELECT * FROM proposal_features WHERE proposal_id = ? AND feature_id = ?', p.id, ctx.params.featureId);
    if (!link) throw notFound('Связь не найдена');
    const f = await first(db, 'SELECT number FROM features WHERE id = ?', link.feature_id);
    await tx(db, [
      stmt(db, 'DELETE FROM proposal_features WHERE proposal_id = ? AND feature_id = ?', p.id, link.feature_id),
      auditStmt(db, user, 'proposal', p.id, 'task_unlinked', [{ field: 'task', old: link.feature_id, new: null }]),
      auditStmt(db, user, 'feature', link.feature_id, 'proposal_unlinked', [{ field: 'proposal', old: proposalKey(p.number), new: null }]),
    ]);
    void f;
    return json({ ok: true });
  });

  /**
   * Merge a duplicate into the main proposal: the duplicate stays (read-only, with its author and history) and points to
   * the main one; its task links and comments move over; a department vote moves only where the main one has none.
   */
  r.post('/api/proposals/:id/merge', async (ctx) => {
    const user = requirePerm(ctx, perms.editCatalog, 'Объединять предложения может продуктовая команда');
    const b = await readJson(ctx, z.object({ target_id: z.string().min(1), source_version: z.number().int(), target_version: z.number().int(), confirm: z.literal(true) }));
    const src = await resolveProposal(ctx, ctx.params.id);
    const dst = await resolveProposal(ctx, b.target_id);
    if (src.id === dst.id) throw badRequest('Нельзя объединить предложение с самим собой');
    if (src.merged_into_id) throw conflict('merged', 'Это предложение уже объединено');
    if (dst.merged_into_id) throw conflict('merged', 'Основное предложение само объединено с другим — выберите его основное');
    const db = ctx.env.DB;
    const now = nowIso();
    await tx(db, [
      guardVersion(db, 'proposals', src.id, b.source_version),
      guardVersion(db, 'proposals', dst.id, b.target_version),
      stmt(db, 'INSERT OR IGNORE INTO proposal_features (proposal_id, feature_id, created_at, created_by) SELECT ?, feature_id, created_at, created_by FROM proposal_features WHERE proposal_id = ?', dst.id, src.id),
      stmt(db, 'DELETE FROM proposal_features WHERE proposal_id = ?', src.id),
      stmt(db, 'INSERT OR IGNORE INTO proposal_votes (proposal_id, department_id, score, voted_by, voted_at) SELECT ?, department_id, score, voted_by, voted_at FROM proposal_votes WHERE proposal_id = ?', dst.id, src.id),
      stmt(db, 'DELETE FROM proposal_votes WHERE proposal_id = ?', src.id),
      stmt(db, 'UPDATE proposal_comments SET proposal_id = ?, moved_from = COALESCE(moved_from, ?) WHERE proposal_id = ?', dst.id, proposalKey(src.number), src.id),
      stmt(db, 'UPDATE proposals SET merged_into_id = ?, updated_at = ?, version = version + 1 WHERE id = ?', dst.id, now, src.id),
      stmt(db, 'UPDATE proposals SET updated_at = ?, version = version + 1 WHERE id = ?', now, dst.id),
      auditStmt(db, user, 'proposal', src.id, 'merged_into', [{ field: 'merged_into', old: null, new: proposalKey(dst.number) }]),
      auditStmt(db, user, 'proposal', dst.id, 'merged_from', [{ field: 'merged_from', old: null, new: `${proposalKey(src.number)} (автор ${src.author_name})` }]),
    ], 'Одно из предложений изменили. Обновите страницу.');
    return json({ ok: true, target: { id: dst.id, key: proposalKey(dst.number) } });
  });
}

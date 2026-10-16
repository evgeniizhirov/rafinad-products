import { z } from 'zod';
import { TASK_KINDS } from '../lib/world';
import { first, newId, nowIso, stmt, type Row } from '../lib/db';
import { auditStmt } from '../lib/audit';
import { badRequest, type Ctx } from '../lib/http';
import { requireUser } from '../lib/auth';
import { nextNumber } from '../lib/numbers';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД').nullable().optional();
const visibility = z.enum(['draft', 'internal', 'public']);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

export const featureFields = {
  title: z.string().trim().min(1, 'Укажите название').max(300),
  description: z.string().max(20000).optional(),
  category_id: z.string().nullable().optional(),
  epic_id: z.string().nullable().optional(),
  status_id: z.string().optional(),
  stage_id: z.string().nullable().optional(),
  author_name: optText(120),
  assignee_name: optText(120),
  requested_at: date,
  planned_start: date,
  planned_end: date,
  visibility: visibility.optional(),
  external_ref: optText(100),
  private_notes: z.string().max(5000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  /** «Офферы» removed in vNext: still accepted (old clients, MCP) and ignored */
  offer_ids: z.array(z.string()).max(100).optional(),
  task_kind: z.enum(TASK_KINDS).optional(),
  /** release commitment to the business (FR-03); only for planned tasks */
  is_focus: z.boolean().optional(),
  /** bugs / operational improvements: urgency (never a department vote) and actual hours after the fix */
  urgency: z.enum(['low', 'medium', 'high', 'critical']).nullable().optional(),
  fact_hours: z.number().min(0).max(100000).nullable().optional(),
  is_product_internal: z.boolean().optional(),
  /** null clears the initiator */
  initiator: z.discriminatedUnion('type', [
    z.object({ type: z.literal('free_text'), name: z.string().trim().min(1, 'Укажите имя инициатора').max(120) }),
    z.object({ type: z.literal('user'), user_id: z.string().min(1) }),
    z.object({ type: z.literal('department'), department_id: z.string().min(1) }),
  ]).nullable().optional(),
};

type InitiatorInput = z.infer<typeof featureFields.initiator>;

/** initiator → the four stored columns (with a name snapshot); validates the referenced user / department */
export async function initiatorColumns(ctx: Ctx, i: InitiatorInput): Promise<Row | undefined> {
  if (i === undefined) return undefined;
  if (i === null) return { initiator_type: null, initiator_user_id: null, initiator_department_id: null, initiator_name: null };
  if (i.type === 'free_text') return { initiator_type: 'free_text', initiator_user_id: null, initiator_department_id: null, initiator_name: i.name };
  if (i.type === 'user') {
    const u = await first(ctx.env.DB, 'SELECT id, name FROM users WHERE id = ?', i.user_id);
    if (!u) throw badRequest('Пользователь-инициатор не найден');
    return { initiator_type: 'user', initiator_user_id: u.id, initiator_department_id: null, initiator_name: u.name };
  }
  const d = await first(ctx.env.DB, 'SELECT id, name FROM departments WHERE id = ?', i.department_id);
  if (!d) throw badRequest('Отдел-инициатор не найден');
  return { initiator_type: 'department', initiator_user_id: null, initiator_department_id: d.id, initiator_name: d.name };
}
export const createSchema = z.object({ ...featureFields, estimates: z.record(z.string(), z.number().min(0).max(100000)).optional() });
export async function validateRefs(ctx: Ctx, b: Record<string, any>) {
  const db = ctx.env.DB;
  const checks: [string | null | undefined, string, string][] = [
    [b.category_id, 'SELECT 1 FROM categories WHERE id = ?', 'Категория не найдена'],
    [b.epic_id, 'SELECT 1 FROM epics WHERE id = ?', 'Эпик не найден'],
    [b.stage_id, 'SELECT 1 FROM stages WHERE id = ?', 'Этап не найден'],
  ];
  for (const [v, sql, msg] of checks) if (v && !(await first(db, sql, v))) throw badRequest(msg);
  if (b.status_id && !(await first(db, `SELECT 1 FROM statuses WHERE id = ? AND entity = 'feature'`, b.status_id))) throw badRequest('Статус не найден');
  if (b.estimates) {
    for (const t of Object.keys(b.estimates)) if (!(await first(db, 'SELECT 1 FROM resource_teams WHERE id = ?', t))) throw badRequest('Ресурсная команда не найдена');
  }
}

export async function semanticOf(ctx: Ctx, statusId: string): Promise<string | null> {
  return (await first<{ semantic: string }>(ctx.env.DB, 'SELECT semantic FROM statuses WHERE id = ?', statusId))?.semantic ?? null;
}


/** Build statements without committing: callers may append their own atomic mutations. */
export async function prepareFeatureCreate(ctx: Ctx, input: unknown, featureId = newId('f'), system = false) {
 const user = system ? null : requireUser(ctx);
 const b = createSchema.parse(input);
    await validateRefs(ctx, b);
    const initiator = (await initiatorColumns(ctx, b.initiator)) ?? { initiator_type: null, initiator_user_id: null, initiator_department_id: null, initiator_name: null };
    const kind = b.task_kind ?? 'planned';
    const internal = b.is_product_internal ? 1 : 0;
    if (b.is_focus && (kind !== 'planned' || internal)) throw badRequest('Фокусной может быть только плановая общая задача');
    const db = ctx.env.DB;
    const statusId = b.status_id ?? 'st_f_new';
    const sem = await semanticOf(ctx, statusId);
    const id = featureId;
    const now = nowIso();
    const num = await nextNumber(db, 'features');
      const statements = [
        stmt(db, `INSERT INTO features (id, number, external_ref, title, description, category_id, epic_id, status_id, stage_id, author_name, assignee_name,
            requested_at, planned_start, planned_end, closed_at, visibility, private_notes, created_at, updated_at, created_by, updated_by,
            task_kind, is_product_internal, initiator_type, initiator_user_id, initiator_department_id, initiator_name, is_focus, urgency, fact_hours)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, num, b.external_ref ?? null, b.title, b.description ?? '', b.category_id ?? null, b.epic_id ?? null, statusId, b.stage_id ?? null,
          b.author_name ?? user?.name ?? '', b.assignee_name ?? null, b.requested_at ?? now.slice(0, 10), b.planned_start ?? null, b.planned_end ?? null,
          sem === 'done' ? now.slice(0, 10) : null, b.visibility ?? 'internal', b.private_notes ?? null, now, now, user?.id ?? null, user?.id ?? null,
          kind, internal, initiator.initiator_type, initiator.initiator_user_id, initiator.initiator_department_id, initiator.initiator_name, b.is_focus ? 1 : 0, b.urgency ?? null, b.fact_hours ?? null),
        ...[...new Set(b.tags ?? [])].map((t) => stmt(db, 'INSERT INTO feature_tags (feature_id, tag) VALUES (?, ?)', id, t)),
        ...Object.entries(b.estimates ?? {}).map(([t, h]) => stmt(db, 'INSERT INTO feature_estimates (feature_id, team_id, hours, is_manual, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?)', id, t, h, now, user?.id ?? null)),
        auditStmt(db, user, 'feature', id, 'created', [
          { field: 'title', old: null, new: b.title },
          ...(kind !== 'planned' ? [{ field: 'task_kind', old: null, new: kind }] : []),
          ...(internal ? [{ field: 'is_product_internal', old: null, new: 1 }] : []),
          ...(initiator.initiator_type ? [{ field: 'initiator', old: null, new: initiator.initiator_name }] : []),
        ]),
      ];

 return { statements, result: { id, number: num, key: `RF-${num}` } };
}


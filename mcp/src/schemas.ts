import * as z from 'zod';
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
export const version = z.number().int().positive();
const date = z.iso.date();
const text = z.string().max(300);
export const filters = z.strictObject({
  q: z.string().max(500).optional(),
  ...Object.fromEntries(['status', 'category', 'epic', 'department', 'release', 'stage', 'kind', 'sprint', 'ids', 'assignee', 'initiator', 'visibility', 'tag'].map(k => [k, text.optional()])),
  hide_closed: z.enum(['0', '1']).optional(), focus: z.enum(['0', '1']).optional(),
  internal: z.enum(['1', 'only', 'all']).optional(),
  created_from: date.optional(), created_to: date.optional(),
  flag: text.optional(), sort: z.enum(['priority', 'number', 'newest', 'title', 'status']).optional(),
});
export const fields = z.strictObject({
  title: z.string().trim().min(1).max(300).optional(), description: z.string().max(20000).optional(),
  category_id: id.nullable().optional(), epic_id: id.nullable().optional(), status_id: id.optional(), stage_id: id.nullable().optional(),
  assignee_name: z.string().max(120).nullable().optional(),
  requested_at: date.nullable().optional(), planned_start: date.nullable().optional(), planned_end: date.nullable().optional(),
  visibility: z.enum(['draft', 'internal', 'public']).optional(), external_ref: z.string().max(100).nullable().optional(),
  private_notes: z.string().max(5000).nullable().optional(), tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  task_kind: z.enum(['planned', 'bug', 'operational_improvement']).optional(),
  is_focus: z.boolean().optional(), urgency: z.enum(['low', 'medium', 'high', 'critical']).nullable().optional(),
  fact_hours: z.number().min(0).max(100000).nullable().optional(), is_product_internal: z.boolean().optional(),
  initiator: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('free_text'), name: z.string().trim().min(1).max(120) }),
    z.strictObject({ type: z.literal('user'), user_id: id }),
    z.strictObject({ type: z.literal('department'), department_id: id }),
  ]).nullable().optional(),
});
export const confirmed = z.literal(true).describe('Only after explicit user confirmation in ChatGPT of this exact operation and its fields. This is not proof of consent; host approval must remain enabled.');
export function query(values: Record<string, unknown>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) p.set(k, String(v));
  return p.size ? `?${p}` : '';
}

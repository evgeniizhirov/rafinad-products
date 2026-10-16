import { z } from 'zod';

// Approved pilot limits. Lengths are UTF-16 code units; HTTP size is UTF-8 bytes.
export const INBOX_DESCRIPTION_LIMIT = 100_000;
export const INBOX_BODY_LIMIT = 500_000;
export const sourceFields = z.object({
  title: z.string().max(300).optional(),
  description: z.string().max(INBOX_DESCRIPTION_LIMIT).optional(),
  source_url: z.string().url().max(4000).refine(v => /^https?:\/\//i.test(v) && !new URL(v).username && !new URL(v).password, 'Нужна HTTP(S)-ссылка без учётных данных').optional(),
  external_status: z.string().max(300).optional(),
  author_name: z.string().max(120).optional(),
  assignee_name: z.string().max(120).optional(),
  initiator_name: z.string().max(120).optional(),
  source_created_at: z.string().max(100).optional(),
  source_due_at: z.string().max(100).optional(),
  project: z.string().max(300).optional(),
  priority: z.string().max(100).optional(),
  source_task_type: z.string().max(300).optional(),
  related_tasks: z.string().max(10000).optional(),
  task_kind: z.enum(['planned','bug','operational_improvement']).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
}).strict();
export const fieldNames = Object.keys(sourceFields.shape) as [string, ...string[]];
export const eventSchema = z.object({
  schema_version: z.literal(1),
  external_task_id: z.string().trim().min(1).max(200),
  event_type: z.enum(['CREATE','UPDATE','BLOCKED','POSTPONED','DONE','REOPENED']),
  source_event_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  source_event_at: z.string().datetime({ offset: true }).optional(),
  payload_mode: z.enum(['patch','snapshot']),
  payload: sourceFields,
  clear_fields: z.array(z.enum(fieldNames)).max(fieldNames.length).default([]),
}).strict().superRefine((e, ctx) => {
  if (e.payload_mode === 'snapshot' && (e.payload.title === undefined || e.payload.description === undefined)) ctx.addIssue({ code: 'custom', message: 'Снимок должен содержать title и description' });
  for (const k of e.clear_fields) if (k in e.payload) ctx.addIssue({ code: 'custom', message: 'Поле нельзя одновременно изменить и очистить' });
  if (e.clear_fields.includes('title')) ctx.addIssue({ code: 'custom', message: 'Название нельзя очищать' });
});
export type InboxEvent = z.infer<typeof eventSchema>;
export type Fields = Record<string, unknown>;
export type Clock = { kind: 'version' | 'time'; value: number };
export type ConflictField = { current: unknown; incoming: unknown };

/** Stable hashes must not depend on the JSON key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function eventClock(e: InboxEvent, ordering: string): Clock | null {
  if (ordering === 'version' && e.source_event_version !== undefined) return { kind: 'version', value: e.source_event_version };
  if (ordering === 'time' && e.source_event_at) return { kind: 'time', value: Date.parse(e.source_event_at) };
  return null;
}

/** Merge per field. Receipt order never establishes source order. RF fields are not touched. */
export function mergeSource(snapshot: Fields, clocks: Record<string, Clock>, e: InboxEvent, ordering: string) {
  const next = { ...snapshot }; const nextClocks = { ...clocks };
  const conflicts: Record<string, ConflictField> = {};
  const clock = eventClock(e, ordering);
  const changes = { ...e.payload } as Fields;
  if(!('external_status' in changes)&&!e.clear_fields.includes('external_status')&&!['CREATE','UPDATE'].includes(e.event_type))changes.external_status=e.event_type;
  for (const key of e.clear_fields) changes[key] = null;
  for (const [key, incoming] of Object.entries(changes)) {
    const previous = clocks[key];
    const same = canonical(next[key]) === canonical(incoming);
    const comparable = !!clock && !!previous && clock.kind === previous.kind;
    if (comparable && clock!.value < previous.value) continue;
    if (!(key in next) || same || (comparable && clock!.value > previous.value)) {
      next[key] = incoming;
      if (clock && (!previous || comparable && clock.value >= previous.value)) nextClocks[key] = clock;
    } else {
      conflicts[key] = { current: next[key], incoming };
    }
  }
  return { snapshot: next, clocks: nextClocks, conflicts };
}

import { z } from 'zod';
import { eventSchema } from './inbox';

export const emailSchema = z.object({ subject:z.string().max(500),from:z.string().max(500),text:z.string().max(200_000) }).strict();
const labels: Record<string,string> = {
  'ID задачи Bitrix':'external_task_id','Ссылка на задачу':'source_url','Название':'title','Дата создания':'source_created_at',
  'Описание':'description','Тип задачи':'source_task_type','Приоритет Bitrix':'priority','Связанные задачи':'related_tasks','Постановщик':'author_name','Крайний срок':'source_due_at',
};
export function normalizeIncoming(raw: unknown, connection: {adapter:string;allowed_sender?:string;source_instance_id:string}) {
  if (connection.adapter!=='bitrix_email') return eventSchema.parse(raw);
  const mail=emailSchema.parse(raw);
  const sender=/<([^<>]+)>/.exec(mail.from)?.[1] ?? mail.from.trim();
  if (!connection.allowed_sender || sender.toLowerCase()!==connection.allowed_sender.toLowerCase()) throw new Error('mail_sender');
  const subject=/^RAFINAD_SYNC\s*\|\s*BITRIX\s*\|\s*(CREATE|UPDATE|BLOCKED|POSTPONED|DONE|REOPENED)\s*\|\s*(\d+)\s*$/.exec(mail.subject.trim());
  if (!subject) throw new Error('mail_subject');
  const lines=mail.text.replace(/\r\n?/g,'\n').split('\n');
  const values:Record<string,string>={}; let current:string|null=null;
  for (const line of lines) {
    const match=/^\s*([^:\n]+):\s?(.*)$/.exec(line);
    const field=match ? labels[match[1].trim()] : undefined;
    if (field) {
      if (field in values) throw new Error('ambiguous_field');
      current=field; values[field]=match![2];
    } else if (current && current!=='source_due_at' && current!=='source_task_type') values[current]+='\n'+line;
  }
  for (const k of Object.keys(values)) if(k!=='source_task_type')values[k]=values[k].trim();
  if (values.external_task_id!==subject[2] || !values.title || !('description' in values) || !values.source_url) throw new Error('mail_fields');
  // Some plain-text renderers wrap the URL. Whitespace is not part of a portal URL.
  values.source_url=values.source_url.replace(/\s+/g,'');
  const url=new URL(values.source_url);
  if (url.protocol!=='https:' || url.hostname.toLowerCase()!==connection.source_instance_id.toLowerCase() || url.username || url.password) throw new Error('mail_portal');
  const id=/\/tasks\/task\/view\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (id!==subject[2]) throw new Error('mail_task_id');
  const {external_task_id,...payload}=values;
  // These are source dates without a timezone, NOT evidence of update order.
  // "Rafinad", "N" and "user_4158" stay raw; no guessed type, urgency or user mapping.
  return eventSchema.parse({schema_version:1,external_task_id,event_type:subject[1],payload_mode:'patch',payload,clear_fields:[]});
}

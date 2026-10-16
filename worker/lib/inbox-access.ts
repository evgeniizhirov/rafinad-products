import { requireUser } from './auth';
import { first } from './db';
import { notFound, type Ctx } from './http';

export async function canAccessInbox(ctx: Ctx): Promise<boolean> {
  const u = ctx.user;
  if (!u || u.apiKey || u.mustChangePassword) return false;
  if (u.role === 'admin') return true; // Owner decision: administrators see everything.
  if (u.role !== 'product') return false;
  return !!await first(ctx.env.DB, `SELECT 1 FROM department_memberships m JOIN departments d ON d.id = m.department_id
    WHERE m.user_id = ? AND d.is_product = 1 AND d.is_active = 1`, u.id);
}
export async function requireInboxAccess(ctx: Ctx) {
  const u = requireUser(ctx);
  if (!await canAccessInbox(ctx)) throw notFound('Раздел не найден');
  return u;
}

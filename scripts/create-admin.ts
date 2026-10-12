// Prints SQL that creates (or resets) an administrator with a temporary password.
// Usage:
//   npx tsx scripts/create-admin.ts admin@company.ru "Имя Фамилия" > .local/admin.sql
//   npx wrangler d1 execute DB --remote --file .local/admin.sql
// The password is printed to stderr once; the user must change it at first login.
import { hashPassword, tempPassword } from '../worker/lib/crypto';

const [email, name = 'Администратор'] = process.argv.slice(2);
if (!email || !email.includes('@')) {
  console.error('Usage: tsx scripts/create-admin.ts <email> [name]');
  process.exit(1);
}
const password = tempPassword();
const hash = await hashPassword(password);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const now = new Date().toISOString();
const id = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
console.log(`INSERT INTO users (id, email, name, role_code, password_hash, must_change_password, is_active, created_at, updated_at)
VALUES (${q(id)}, ${q(email.toLowerCase())}, ${q(name)}, 'admin', ${q(hash)}, 1, 1, ${q(now)}, ${q(now)})
ON CONFLICT(email) DO UPDATE SET role_code = 'admin', password_hash = excluded.password_hash, must_change_password = 1, is_active = 1, updated_at = excluded.updated_at;`);
console.error(`\nВременный пароль для ${email}: ${password}\nСмените его при первом входе.\n`);

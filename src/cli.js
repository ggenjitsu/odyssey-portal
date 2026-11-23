// Small maintenance commands. Run with: npm run cli -- <command>
//   sync                                   pull every board once and print what changed
//   invite <email> <role> [client-slug]    create a login and print its invite link
//   status                                 print the admin overview as JSON
import { config } from './config.js';
import { boot } from './boot.js';
import { syncAll } from './sync.js';
import { createInvite } from './auth.js';
import { adminOverview } from './metrics.js';
import { nowIso } from './db.js';

const [command, ...args] = process.argv.slice(2);
const { db, notion } = await boot(config);

if (command === 'sync') {
  if (!notion) throw new Error('NOTION_TOKEN is not set');
  console.log(JSON.stringify(await syncAll(db, notion), null, 2));
} else if (command === 'invite') {
  const [email, role, slug] = args;
  if (!email || !['admin', 'editor', 'client'].includes(role)) throw new Error('Usage: invite <email> <admin|editor|client> [client-slug]');
  const client = slug ? db.prepare('SELECT id FROM clients WHERE slug = ?').get(slug) : null;
  if (role === 'client' && !client) throw new Error('A client login needs a valid client slug');
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) {
    const r = db.prepare('INSERT INTO users (email, role, client_id, created_at) VALUES (?, ?, ?, ?)').run(email.toLowerCase(), role, client?.id ?? null, nowIso());
    user = { id: Number(r.lastInsertRowid) };
  }
  console.log(`${config.baseUrl}/invite/${createInvite(db, user.id)}`);
} else if (command === 'status') {
  console.log(JSON.stringify(adminOverview(db, config), null, 2));
} else {
  console.log('Commands: sync | invite <email> <role> [client-slug] | status');
}
db.close();

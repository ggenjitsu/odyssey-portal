import fs from 'node:fs';
import path from 'node:path';
import { openDb, nowIso } from './db.js';
import { hashPassword, verifyPassword, MIN_PASSWORD } from './auth.js';
import { createNotion } from './notion.js';
import { createSlack } from './slack.js';
import { createStripe } from './stripe.js';

// Opens the database and builds the service clients. Shared by the server and the command line.
export async function boot(cfg, log = console) {
  const db = openDb(cfg.dataDir === ':memory:' ? ':memory:' : path.join(cfg.dataDir, 'portal.sqlite3'));

  // First run: load the known client boards.
  if (!db.prepare('SELECT 1 FROM clients LIMIT 1').get()) {
    const seedFile = path.resolve('seed/clients.json');
    const seed = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, 'utf8')) : [];
    const insert = db.prepare(
      'INSERT INTO clients (slug, name, notion_data_source_id, notion_url, package_size, package_max, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const c of seed) insert.run(c.slug, c.name, c.notion_data_source_id ?? null, c.notion_url ?? null, c.package_size ?? null, c.package_max ?? null, nowIso());
  }

  // The owner's login comes from the environment and always works while those two settings are there.
  // That makes it the way back in after a lockout: set a new ADMIN_PASSWORD and redeploy.
  // Remove ADMIN_PASSWORD once you have chosen your own password through an invite link.
  if (cfg.adminEmail && cfg.adminPassword.length >= MIN_PASSWORD) {
    const owner = db.prepare('SELECT * FROM users WHERE email = ?').get(cfg.adminEmail);
    if (!owner) {
      db.prepare("INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, 'Founder', 'admin', ?, ?)")
        .run(cfg.adminEmail, await hashPassword(cfg.adminPassword), nowIso());
      log.info(`Created the founder login for ${cfg.adminEmail}`);
    } else if (!(await verifyPassword(cfg.adminPassword, owner.password_hash)) || owner.role !== 'admin' || !owner.active) {
      db.prepare("UPDATE users SET password_hash = ?, role = 'admin', active = 1 WHERE id = ?").run(await hashPassword(cfg.adminPassword), owner.id);
      log.info(`Reset the founder login for ${cfg.adminEmail} from the environment`);
    }
  } else if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND active = 1 AND password_hash IS NOT NULL LIMIT 1").get()) {
    log.warn(`No founder login yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (${MIN_PASSWORD}+ characters) and redeploy`);
  }

  const notion = cfg.notionToken ? createNotion({ token: cfg.notionToken, version: cfg.notionVersion }) : null;
  const slack = cfg.slackToken ? createSlack({ token: cfg.slackToken }) : null;
  const stripe = cfg.stripeKey ? createStripe({ key: cfg.stripeKey }) : null;
  if (!notion) log.warn('NOTION_TOKEN is not set: nothing will sync');
  if (!slack) log.info('SLACK_BOT_TOKEN is not set: the "waiting on a reply" check is off');
  if (!stripe) log.info('STRIPE_API_KEY is not set: billing periods fall back to each client\'s anchor date');
  return { db, notion, slack, stripe };
}

import fs from 'node:fs';
import path from 'node:path';
import { syncAll } from './sync.js';
import { refreshSlack } from './slack.js';
import { refreshBilling } from './stripe.js';

// Run fn at most once at a time; callers that arrive mid-run share the same result.
const single = (fn) => {
  let running = null;
  return () => (running ||= Promise.resolve().then(fn).finally(() => { running = null; }));
};

export function createJobs({ db, cfg, notion, slack, stripe, log = console }) {
  const sync = single(async () => {
    if (!notion) return { ok: false, results: [], error: 'NOTION_TOKEN is not set' };
    const result = await syncAll(db, notion);
    for (const r of result.results) if (!r.ok) log.error(`sync ${r.client} failed: ${r.error}`);
    return result;
  });
  const slackCheck = single(async () => (slack ? refreshSlack(db, slack) : 0));
  const billing = single(async () => (stripe ? refreshBilling(db, stripe) : 0));

  // One snapshot of the database per day, the last seven kept.
  function backup() {
    if (cfg.dataDir === ':memory:') return;
    const dir = path.join(cfg.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `portal-${new Date().toISOString().slice(0, 10)}.sqlite3`);
    if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = fs.readdirSync(dir).filter((f) => /^portal-\d{4}-\d{2}-\d{2}\.sqlite3$/.test(f)).sort().slice(0, -7);
    for (const f of old) fs.unlinkSync(path.join(dir, f));
  }

  const safe = (name, fn) => async () => {
    try {
      await fn();
    } catch (err) {
      log.error(`${name} failed: ${err.message}`);
    }
  };

  const timers = [];
  return {
    sync,
    slack: slackCheck,
    billing,
    backup,
    start() {
      const every = (minutes, name, fn) => {
        const run = safe(name, fn);
        run();
        timers.push(setInterval(run, minutes * 60_000));
      };
      every(cfg.syncMinutes, 'sync', async () => { await sync(); await slackCheck(); });
      every(cfg.billingMinutes, 'billing', billing);
      every(60, 'backup', async () => backup());
    },
    stop() {
      timers.forEach(clearInterval);
    },
  };
}

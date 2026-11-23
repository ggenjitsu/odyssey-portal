import { config } from './config.js';
import { boot } from './boot.js';
import { createJobs } from './jobs.js';
import { buildServer } from './server.js';

const { db, notion, slack, stripe } = await boot(config);
const jobs = createJobs({ db, cfg: config, notion, slack, stripe });
const app = await buildServer({ db, cfg: config, notion, slack, stripe, jobs, logger: { level: 'warn' } });

await app.listen({ port: config.port, host: config.host });
console.info(`Odyssey Portal listening on ${config.host}:${config.port}`);
jobs.start();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    jobs.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}

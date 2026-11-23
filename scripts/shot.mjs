// Local preview only: screenshots the seeded portal so the design can be checked.
//   node scripts/shot.mjs <out-dir> name:email:path:width ...
import { createRequire } from 'node:module';

const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [out = '/tmp/shots', ...shots] = process.argv.slice(2);
const base = 'http://localhost:3222';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
for (const spec of shots) {
  const [name, email, path = '/', width = '1440'] = spec.split(':');
  const ctx = await browser.newContext({ viewport: { width: Number(width), height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !/401/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  if (email) await ctx.request.post(`${base}/api/auth/login`, { headers: { 'x-portal': '1' }, data: { email, password: 'local-preview-1' } });
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: Boolean(email) });
  console.log(name, errors.length ? `ERRORS: ${errors.slice(0, 4).join(' | ')}` : 'ok');
  await ctx.close();
}
await browser.close();

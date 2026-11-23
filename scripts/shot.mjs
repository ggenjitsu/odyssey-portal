// Local preview only: screenshots the seeded portal so the design can be checked.
//   node scripts/shot.mjs <out-dir> [backdrop-url]
import { createRequire } from 'node:module';

const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const [out = '/tmp/shots', backdrop = ''] = process.argv.slice(2);
const base = 'http://localhost:3222';

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const shoot = async (name, width, height, signedIn) => {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  if (signedIn) await ctx.request.post(`${base}/api/auth/login`, { headers: { 'x-portal': '1' }, data: { email: 'admin@local.test', password: 'local-preview-1' } });
  await page.goto(base, { waitUntil: 'networkidle' });
  if (backdrop) {
    await page.evaluate((src) => {
      const el = document.getElementById('backdrop');
      const node = /\.mp4/.test(src) ? Object.assign(document.createElement('video'), { src, muted: true, autoplay: true, loop: true }) : Object.assign(document.createElement('img'), { src });
      el.replaceChildren(node);
    }, backdrop);
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: signedIn });
  if (errors.length) console.log(name, 'errors:', errors.slice(0, 5));
  await ctx.close();
};
await shoot('login', 1440, 900, false);
await shoot('admin', 1440, 900, true);
await shoot('admin-mobile', 390, 844, true);
await browser.close();
console.log('done');

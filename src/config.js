import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  prod: env.NODE_ENV === 'production',
  dataDir: env.DATA_DIR || path.resolve('data'),
  tz: env.PORTAL_TZ || 'Europe/London',
  baseUrl: (env.BASE_URL || '').replace(/\/$/, ''),
  syncMinutes: Math.max(1, Number(env.SYNC_MINUTES || 5)),
  billingMinutes: Math.max(5, Number(env.BILLING_MINUTES || 60)),
  notionToken: env.NOTION_TOKEN || '',
  notionVersion: env.NOTION_VERSION || '2025-09-03',
  slackToken: env.SLACK_BOT_TOKEN || '',
  stripeKey: env.STRIPE_API_KEY || '',
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
};

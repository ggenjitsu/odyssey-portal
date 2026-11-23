# Odyssey Portal

One portal for Odyssey Digital with three logins: admin, client and editor. Notion stays the place where work is tracked. The portal copies every client board every 5 minutes, logs each change, and builds its numbers from that log.

## How it works

1. **Sync.** Every 5 minutes the server pulls every card from each client's Notion board into its own database (`cards`).
2. **Change log.** Each pull is compared with the last one. Every status, approval and editor change is written to `events` with the card, the old and new value, the editor on the card and the time. The log is append-only: the database refuses edits and deletes.
3. **Views.** Admin sees every client, delivery counts, package progress, runway, editor output, Slack channels waiting on a reply and billing. A client sees only their own videos and can approve, request changes or mark a video posted. An editor sees their queue and what they finished today and this week.
4. **Write-back.** Portal actions are written to Notion first, then logged locally with who did it. If Notion refuses, nothing is stored.

Video review itself stays in FreeFrame. Each card carries its review link, and files attached to the card's "Edited version" column play straight from Notion.

## Definitions

These live in `src/rules.js`. Change them there and every count follows.

| Term | Meaning |
|---|---|
| Delivered | A video's first move into **Posted**. Ready means finished but not out yet. A video counts once per account it was posted on: the card's "Accounts Posted" number if the board has that column, else the client's counts-as setting |
| Needs review | Status is **Review**: waiting on the team's own check (Ahmed or Genji) before the client sees it |
| Editor finished | A move from **Ready to Edit / Editing / Revisions** into **Review / Ready / Posted**, credited to the editor on the card at that moment |
| Needs approval | Status is **Ready** and Approval is "Needs … Approval" (or still "Changes Requested" after a rework) |
| Runway | Ready videos ÷ the client's posting rate over the last 30 days, in days |
| Package progress | Delivered this billing period vs the client's package, which can be a range (30 to 45). Pace is judged against the lower number. The period comes from Stripe, else the client's anchor date, else the calendar month |

Numbers from before the portal's first sync are estimates built from Notion's Posted Date and last-edited time. They are stored with `source = 'backfill'`.

## Board requirements

A board needs a **Status** column using the shared stage names (Idea, Scripting, Filming, Ready to Edit, Editing, Revisions, Review, Ready, Posted, Archive). Everything else is optional and matched by name: Approval, Editor (or Person), Due Date, Posted Date, Posted Video Link, Review Link, Script, Inspo, Priority, Funnel, Posting, Delay reason, Edited version. Status can be a Status or a Select column. Approval options can carry the client's name ("Needs Elena Approval").

## Run it locally

```
cp .env.example .env      # fill in NOTION_TOKEN, ADMIN_EMAIL, ADMIN_PASSWORD
npm install
npm run dev               # http://localhost:3000
npm test
```

Needs Node 22.13 or newer. The database is a single SQLite file in `DATA_DIR`.

## Settings

| Variable | Needed | What it is |
|---|---|---|
| `NOTION_TOKEN` | yes | Internal integration secret. Share each client board with the integration |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first run | Creates the first admin login. Password is 10+ characters |
| `BASE_URL` | yes | Public address, used in invite links |
| `DATA_DIR` | yes in production | Folder for the database and backups. Must be on a persistent volume |
| `SLACK_BOT_TOKEN` | optional | Turns on the "waiting on a reply" check |
| `STRIPE_API_KEY` | optional | Restricted read-only key. Turns on billing periods and invoice status |
| `PORTAL_TZ` | optional | Time zone for "today" and "this week". Default `Europe/London` |
| `SYNC_MINUTES` | optional | Default 5 |

## API

All routes are under `/api`. Logins use a cookie. Changes must come from the portal's own pages.

- `POST /auth/login`, `POST /auth/logout`, `POST /auth/accept-invite`, `GET /me`
- `GET /admin/overview`, `GET /client/overview`, `GET /editor/overview`
- `POST /cards/:id/approve`, `/request-changes`, `/mark-posted`, `/review`, `/status`; `GET /cards/:id/media`, `/feedback`
- Admin: `/admin/clients`, `/admin/users`, `/admin/api-keys`, `/admin/settings`, `/admin/events`, `/admin/sync`, `/admin/sync-runs`, `/admin/notion/boards`, `/admin/slack/channels`, `/admin/slack/users`, `/admin/stripe/customers`
- `GET /v1/summary` with `Authorization: Bearer <key>`: the admin overview, read-only, for other tools. Keys are made under `/admin/api-keys` and can do nothing else.

## Layout

```
src/rules.js     stage names and the rules built on them
src/notion.js    Notion client, column matching, card normaliser
src/sync.js      pull, compare, log; portal write-back
src/metrics.js   the three overviews
src/server.js    logins, permissions, routes
src/slack.js     waiting-on-a-reply check      src/stripe.js   billing snapshot
src/jobs.js      schedule and daily backup     src/db.js       schema and migrations
test/            sync and permission tests against a stand-in Notion
```

See `RUNBOOK.md` for deploying and running it.

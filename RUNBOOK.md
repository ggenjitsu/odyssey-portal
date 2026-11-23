# Runbook

How to deploy, run and fix the Odyssey Portal. Written so the owner never depends on whoever built it.

## Deploy on Railway

1. **New project** → **Deploy from GitHub repo** → pick `odyssey-portal`. Railway reads `railway.json` and builds the `Dockerfile`.
2. **Add a volume** to the service, mounted at `/data`. Give it at least 1 GB. Without it the database is wiped on every deploy.
3. **Variables** tab → add `NOTION_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `BASE_URL` (the public address from step 4), and optionally `SLACK_BOT_TOKEN`, `STRIPE_API_KEY`, `PORTAL_TZ`. `DATA_DIR=/data` is already set by the Dockerfile.
4. **Settings → Networking → Generate domain** (or attach your own). Railway handles HTTPS.
5. Keep **one replica**. The database is a single file and the sync runs inside the web process.
6. Open `<address>/api/health`. `notion: true` means the token loaded. `last_sync_at` fills in within a minute.

The login in `ADMIN_EMAIL` and `ADMIN_PASSWORD` is reset to those values on every start, so it is the way back in after a lockout: set a new `ADMIN_PASSWORD` (10+ characters) and redeploy. Once the founders have their own logins from the People screen, delete `ADMIN_PASSWORD` so it stops overriding. `/api/health` shows `founder_login_ready: false` when nobody can sign in.

## Everyday jobs

| Job | How |
|---|---|
| Add a client | Share their board with the "Odyssey Portal" integration in Notion (••• → Connections). Then `POST /api/admin/clients` with `name` and `notion` (the board link). Unattached boards are listed at `/api/admin/notion/boards` |
| Set a client's package | `PATCH /api/admin/clients/:id` with `package_size` (and `package_max` for a range), plus either `stripe_customer_id` or `period_anchor` (a date; its day of the month starts each period). `count_multiplier` sets how many videos each post counts as when the board has no "Accounts Posted" column |
| Watch a Slack channel | `PATCH /api/admin/clients/:id` with `slack_channel_id`. The bot must be invited to the channel |
| Add a login | `POST /api/admin/users` with `email`, `role` and, for clients, `client_id`. Send the returned invite link. It works once and expires in 7 days |
| Reset a password | `POST /api/admin/users/:id/invite` and send the new link |
| Remove a login | `PATCH /api/admin/users/:id` with `active: false`. They are signed out at once |
| Give another tool read access | `POST /api/admin/api-keys`. The key is shown once. Revoke with `DELETE /api/admin/api-keys/:id` |
| Force a sync | `POST /api/admin/sync`, or from a shell: `npm run cli -- sync` |

Editors are matched to their Notion account by email. If an editor's portal email differs from their Notion email, set `notion_user_id` on the user (the list at `/api/admin/users` includes everyone seen on a card).

## When something is wrong

**Numbers look stale.** Check `/api/admin/sync-runs`. Each run lists every board with `ok` and any error.

- `401 unauthorized`: the Notion token is wrong or was regenerated. Update `NOTION_TOKEN` and redeploy.
- `404 object_not_found`: the board is not shared with the integration. Re-add the connection in Notion.
- `This board has no Status column`: the Status column was renamed. Rename it back.
- `429` or `5xx`: Notion is rate limiting or down. The sync retries, then waits for the next run.

**A sync failed. Did we lose changes?** No. A failed pull stores nothing. The next good pull compares against the last stored state, so every card's change is logged then. The one loss is detail: a card that moved Editing → Review → Ready during an outage is logged as Editing → Ready.

**A client says a button did nothing.** The portal writes to Notion before it stores anything. If Notion refused, the client saw an error and nothing changed. Check the service logs for the Notion message. The usual cause is a renamed column or a missing Approval option.

**Slack shows the wrong people as clients.** By default, full members of the workspace are the team, and guests or people from other workspaces are clients. To set the team by hand, `PATCH /api/admin/settings` with `slack_team_user_ids`.

**Billing is missing for a client.** Check `stripe_customer_id` on the client and that the Stripe key has Read on Customers, Subscriptions and Invoices. The error is stored on the client's billing row and shown in the admin overview.

## Backups and restore

The server writes one snapshot a day to `/data/backups/portal-YYYY-MM-DD.sqlite3` and keeps seven.

To restore: stop the service, copy the snapshot over `/data/portal.sqlite3`, delete `/data/portal.sqlite3-wal` and `-shm` if present, start the service. The next sync brings cards up to date. Events between the snapshot and the restore are gone.

The volume itself is a single point of failure. Download a snapshot now and then, or turn on Railway volume backups.

## Changing the code

- Run `npm test` before every push. The tests cover the sync, the change log and who can see what.
- Database changes: append a new entry to `MIGRATIONS` in `src/db.js`. Never edit one that has shipped.
- Stage names and the definitions of delivered, finished and needs approval are in `src/rules.js`.
- Pushing to `main` redeploys. The service restarts in a few seconds and the sync resumes on its own.

## Security notes

- Passwords are stored as scrypt hashes. Session, invite and API tokens are stored as SHA-256 hashes.
- Client logins are filtered on the server to their own client and to videos that have reached them. This is tested in `test/api.test.js`.
- The Notion, Slack and Stripe secrets live only in Railway Variables. Never commit `.env`.
- The Stripe key should be a restricted, read-only key. The portal never writes to Stripe.

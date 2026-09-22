# aggie-inbox v1.0 — the APS inbox off Google Apps Script

**What it does:** keeps your unified inbox ready 24/7 so the app reads it in ~100ms.
Emails sync straight from Gmail every 10s (history deltas). Calls / texts / FB / IG rows
and your state (handled, filed, folders, stars, machine drawer, mutes) are pulled from
the APS kit every 30s. Every tap (delete, move, handled, star, read) is answered here
instantly — Gmail is told directly, kit-owned state is forwarded behind with retries — and
the answer is overlaid immediately, so nothing snaps back.

**Not the memory server.** Separate service, separate database. Aggie's mind is untouched.

If the service is down or unset, the app silently uses Apps Script exactly as before.

---

## Setup (about 20 minutes, once)

### A. Gmail credentials (so the service can read Sales@ without Apps Script)

1. Go to https://console.cloud.google.com → pick or create a project (any name, e.g. `aggie-inbox`). Make sure you're signed in as **Sales@ApexPestSolutionsllc.com** (or an admin of that Workspace).
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → User type **Internal** (Workspace) → app name `aggie-inbox`, your email for both contacts → Save. (Internal = no verification, no test-user list.)
4. **APIs & Services → Credentials → + Create credentials → OAuth client ID** → Application type **Desktop app** → name `aggie-inbox-desktop` → Create. Copy the **Client ID** and **Client secret**.
5. On your PC, in the folder holding `get-token.js`:
   ```
   node get-token.js <CLIENT_ID> <CLIENT_SECRET>
   ```
   A browser opens → sign in as **Sales@** → Allow. The terminal prints `GOOGLE_REFRESH_TOKEN=…`. Copy it. (Keep it private — it's the mailbox.)

### B. Render service

1. GitHub: new private repo `aggie-inbox` with `server.js`, `package.json`, `get-token.js`, `README.md` (same pattern as aggie-gateway).
2. Render → **New → Web Service** → connect the repo → Runtime **Node**, Build `npm install`, Start `node server.js`. Instance: **Starter ($7)** — this one must never nap; it's the inbox.
3. **Disks** → Add disk: name `data`, mount path `/data`, 1 GB.
4. **Environment** — add:
   | key | value |
   |---|---|
   | `INBOX_KEY` | a long random string (make one up; 30+ chars) |
   | `DB_PATH` | `/data/inbox.db` |
   | `GAS_URL` | the kit's web app **/exec** URL (the same one Twilio uses) |
   | `GAS_KEY` | the kit's `WEBHOOK_KEY` (Script Properties) |
   | `GOOGLE_CLIENT_ID` | from A4 |
   | `GOOGLE_CLIENT_SECRET` | from A4 |
   | `GOOGLE_REFRESH_TOKEN` | from A5 |
   | `TZ_NAME` | `America/New_York` |
5. Deploy. Open `https://<your-service>.onrender.com/health` — expect `gmail.err` empty, `rows` > 0 within a minute, `kit.lastAt` recent.

### C. Point the app at it (kit v38.645+)

1. Apps Script → Project Settings → **Script Properties** → add
   `INBOX_SVC_URL` = `https://<your-service>.onrender.com` and `INBOX_SVC_KEY` = the `INBOX_KEY` you chose.
2. Deploy the kit (v38.645 or later) → hard-refresh the app. The inbox pill reads **⚡ service · 0.1s**.
3. Run `DEPLOY_CHECK` — step **19 inbox service** must be green.

---

## Doors (all need `?key=` or header `X-Inbox-Key`)

| door | what |
|---|---|
| `GET /health` | no key; sync ages, errors, outbox depth |
| `GET /inbox?etag=` | `{rows, folders, etag}` — same etag → `{same:true}` |
| `GET /inbox/thread?id=` | a thread; Gmail direct for mail, kit for call/text/FB |
| `GET /inbox/att?msg=&att=` | one attachment (tap-to-load chips) |
| `POST /inbox/act` | `{act, ids, folder?, keys?, examples?}` — acts: trash archive star unstar read unread done undone filed mach unmach mute unmute ops unops |
| `POST /inbox/pull` | pull the kit lanes now |
| `POST /inbox/resync` | full Gmail rebuild |

## Rules it keeps (from the kit)
- Row shape = the kit's `mailRow_` + `getUnifiedInbox` overlay, field for field.
- Text/call "delete" = handled-forever (v38.439); the record stays.
- Handled bounce-back (v31.3/v31.9): they spoke after you filed it → back out of Handled.
- The owner's taps override the mirror for 15 minutes or until the kit confirms.

## If something's off
- `/health` → `gmail.err` says "credentials missing" → env vars; "invalid_grant" → re-run get-token.js (token revoked).
- `kit.err` → GAS_URL/GAS_KEY wrong, or the kit isn't on v38.645+ (no `hook=ibxlanes`).
- `outbox` climbing → the kit is refusing `hook=ibxact`; check `hookIbxAct_` in the kit logs.
- App pill says "✓ live" not "⚡ service" → `INBOX_SVC_URL`/`KEY` not set, or the service failed once in the last 60s (it falls back automatically).

# ReminderKrunga — Web Push server (iOS / hosted PWA)

Cloudflare Worker (free tier) that keeps the phone awake for reminders when the
app is closed: stores each device's push subscription + schedule, and every
minute nudges the ones coming due — mirroring Android's chain alerts
(+0, +1m, +3m, +7m), with a 10-minute grace window and stale reminders dropped.

- `worker-core.js` — all logic (register / sync / dismiss / test / state / cron)
- `worker.js` — thin entry (workerd rejects non-function module exports)
- `test-local.js` — 43-check test: in-memory KV + mock APNs, then a real
  `wrangler dev` run pushing to an HTTPS echo endpoint

## Run the tests

```sh
cd push-server
npm install                 # once (web-push + wrangler)
node test-local.js          # 43/43 expected
```

`RK_ECHO_URL` overrides the echo endpoint used by part 2.

## KV budget (free tier — important)

Free tier gives 100,000 **reads** but only **1,000 writes/deletes/lists per
day**. The cron runs 1,440 times/day, so a `list()` inside every sweep would
blow the quota — and once exceeded, **all** KV operations fail with 429 until
00:00 UTC (notifications die for the rest of the day).

The device set therefore lives in a single `devices` index key
(`deviceIndex()`): each sweep costs 1 read (index) + 1 read per device, and
writes happen only when a chain step advances, a reminder changes, or a
device registers. Never add a per-sweep `list()`/`put()`.

## Deploy (one time, free Cloudflare account, no card)

```sh
cd push-server
npx wrangler login
npx wrangler kv namespace create STORE
```

Paste the returned `id` into `wrangler.toml` → `id = "..."` (KV binding),
then:

```sh
npx wrangler secret put VAPID_PUBLIC_KEY     # value printed by: node gen-keys.js
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler deploy
```

`wrangler deploy` prints the worker URL, e.g.
`https://rk-push.<something>.workers.dev`.

## Wire the app to it

1. Put the worker URL + VAPID **public** key into `../www/push-config.js`:

   ```js
   window.RK_PUSH = {
     api: 'https://rk-push.<something>.workers.dev',
     vapidPublicKey: '<VAPID_PUBLIC_KEY>'
   };
   ```

2. Commit + push → GitHub Pages republishes the PWA.
3. Smoke check: `curl https://rk-push.<something>.workers.dev/` → health JSON.

## API

`POST` JSON to every route with `{ deviceKey, ... }`:

| route          | body                                        | reply              |
|----------------|---------------------------------------------|--------------------|
| `/api/register`| `deviceKey, subscription`                   | `{ok, devices}`    |
| `/api/sync`    | `deviceKey, reminders:[{id,title,note,fireMs}]` (full list) | `{ok, count}` |
| `/api/dismiss` | `deviceKey, id, mode: done\|stop\|snooze\|quiet` | `{ok}`         |
| `/api/test`    | `deviceKey`                                 | `{ok}` (sends one) |
| `/api/state`   | `deviceKey`                                 | `{count, reminders}` |
| `GET /`        | —                                           | health + version   |

Cron `* * * * *` sweeps due reminders and sends declarative Web Push payloads
(`{web_push: 8030, notification: {title, body, navigate, ...}}`); the app's
`www/sw.js` renders them and `?r=<id>&act=...` deep-links into the alarm screen.

## iPhone end-to-end check

1. Safari → `https://anuj6112008.github.io/ReminderKrunga/` → Share →
   **Add to Home Screen**.
2. Open from the home screen → card **Enable alarm notifications** → Allow.
   A **test notification** should arrive right away.
3. Create a reminder 3 minutes out → lock the phone → notification arrives
   within 0–60s of the due time → tap → alarm screen with Snooze/Done.

Notes: notification arrives 0–60s after the exact minute (cron granularity);
with the app open, the in-app alarm still fires at the exact second.

/*
 * ReminderKrunga push server (Cloudflare Worker, free tier).
 *
 * Why this exists: iOS has no app process we can wake up - the only way to
 * make a locked, screen-off iPhone show an alarm notification at an exact
 * minute is a server sending a Web Push at that minute. This worker:
 *
 *   POST /api/register  { deviceKey, subscription }   -> store push endpoint
 *   POST /api/sync      { deviceKey, subscription?, reminders } -> replace schedule
 *   POST /api/dismiss   { deviceKey, id, mode, snoozeMs } -> stop chain / resnooze
 *   POST /api/test      { deviceKey }                 -> send a test notification
 *   GET  /                                        -> health
 *
 * cron "* * * * *": for every device, send the next due nudge. Nudges are a
 * chain (+0, +1m, +3m, +7m) so a missed first ping still gets followed up,
 * mirroring the Android chain alerts.
 *
 * Payload is the W3C Declarative Web Push format, so iOS 18.4+ renders it
 * even if the site's service worker was evicted. Tapping opens
 * SITE_URL/?r=<id>&step=<n>, which the app turns into the alarm screen.
 */

import webpush from 'web-push';

const CHAIN = [0, 60000, 180000, 420000]; // nudge offsets after fire time
const GRACE = 10 * 60000;                 // never blast a nudge older than this
const MAX_REMINDERS = 200;
const MAX_BODY = 65536;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    }
  });
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** Device keys are opaque to us in listings - hash them. */
async function storeKey(deviceKey) {
  const bytes = new TextEncoder().encode(String(deviceKey));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `dev:${hex}`;
}

function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string') return false;
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false; // http: only for local tests
  } catch (e) {
    return false;
  }
  return !!(sub.keys && sub.keys.p256dh && sub.keys.auth);
}

/** Client list -> our stored shape. Keeps chainStep unless the time moved. */
function mergeReminders(existing, incoming) {
  const oldById = new Map((existing || []).map((r) => [r.id, r]));
  const out = [];
  for (const raw of (Array.isArray(incoming) ? incoming : []).slice(0, MAX_REMINDERS)) {
    if (!raw) continue;
    const id = String(raw.id || '').slice(0, 80);
    const fireMs = Number(raw.fireMs);
    if (!id || !Number.isFinite(fireMs)) continue;
    if (raw.done === true) continue;
    const prev = oldById.get(id);
    const sameTime = prev && Number(prev.fireMs) === fireMs;
    out.push({
      id,
      title: String(raw.title || 'Reminder').slice(0, 160),
      note: String(raw.note || '').slice(0, 300),
      fireMs,
      chainStep: sameTime ? (Number(prev.chainStep) || 0) : 0
    });
  }
  out.sort((a, b) => a.fireMs - b.fireMs);
  return out;
}

async function pushVapid(env) {
  return {
    subject: env.VAPID_SUBJECT || 'mailto:reminder@example.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
}

/**
 * Send one declarative Web Push. Returns null on success, or the status
 * code to react to (404/410 = endpoint is gone -> drop the device).
 */
async function sendPush(env, subscription, payload, ttl = 600) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: await pushVapid(env),
      TTL: ttl,
      urgency: 'high'
    });
    return null;
  } catch (err) {
    const code = err && (err.statusCode || (err.response && err.response.statusCode));
    // Surfaced in `wrangler tail` / dashboard logs - without this a dead
    // push path is indistinguishable from a scheduling bug.
    console.log(
      'push failed:',
      err && err.message,
      'status:',
      typeof code === 'number' ? code : 'none',
      'endpoint:',
      subscription && subscription.endpoint
    );
    if (typeof code === 'number') return code;
    return 500;
  }
}

function nudgePayload(r, step, siteUrl, pending) {
  const bodies = [
    r.note || 'Tap to open your reminder',
    `Still pending — ${r.note || 'tap to open'}`,
    `Reminder nudge ${step + 1} — ${r.title}`,
    `Last call — ${r.title}`
  ];
  return {
    web_push: 8030, // RFC 8030 magic value = render without JavaScript
    notification: {
      title: step === 0 ? r.title : r.title,
      body: bodies[Math.min(step, bodies.length - 1)],
      navigate: `${siteUrl}?r=${encodeURIComponent(r.id)}&step=${step}`,
      tag: `rk-${r.id}`,
      renotify: true,
      silent: false,
      requireInteraction: true,
      app_badge: String(pending),
      lang: 'en',
      dir: 'ltr'
    }
  };
}

/**
 * One device, one cron pass. Chain steps: due -> send -> advance; anything
 * past its fresh window is dropped so a stale reminder can never blast later.
 * Returns 'dead' when the push endpoint has been unregistered.
 */
async function processDevice(env, key, state, now) {
  if (!state || !validSubscription(state.subscription) || !Array.isArray(state.reminders)) {
    return false;
  }
  const siteUrl = (env.SITE_URL || '/').replace(/\/?$/, '/');
  let changed = false;
  const keep = [];

  for (const r of state.reminders) {
    const rawStep = Number(r.chainStep) || 0;
    const step = Math.min(rawStep, CHAIN.length - 1);
    const dueAt = Number(r.fireMs) + CHAIN[step];
    const chainDone = rawStep >= CHAIN.length;

    // Waiting for the next nudge.
    if (!chainDone && dueAt > now) { keep.push(r); continue; }

    // Too old to be worth nudging (missed while offline) -> drop it.
    if (now - dueAt > GRACE) { changed = true; continue; }

    // Final window after the last nudge: keep it a while, then clean up.
    if (chainDone) { keep.push(r); continue; }

    const code = await sendPush(
      env,
      state.subscription,
      nudgePayload(r, step, siteUrl, state.reminders.length),
      Math.max(60, Math.ceil((dueAt + GRACE - now) / 1000) + 60)
    );
    if (code === 404 || code === 410) return 'dead';
    if (code !== null) {
      // Transient failure (APNs hiccup): keep chainStep, retry next minute
      // while the nudge is still inside its fresh window.
      keep.push(r);
      continue;
    }
    r.chainStep = rawStep + 1;
    changed = true;
    keep.push(r);
  }

  state.reminders = keep;
  if (changed) await env.STORE.put(key, JSON.stringify(state));
  return changed;
}

async function sweep(env) {
  const now = Date.now();
  let cursor;
  let dead = 0;
  do {
    const page = await env.STORE.list({ prefix: 'dev:', cursor, limit: 100 });
    for (const item of page.keys) {
      const state = await env.STORE.get(item.name, 'json');
      if (!state) continue;
      const result = await processDevice(env, item.name, state, now);
      if (result === 'dead') {
        dead += 1;
        await env.STORE.delete(item.name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return dead;
}

async function loadDevice(request, env) {
  const body = await readJson(request);
  if (!body || !body.deviceKey) return { error: 'deviceKey required' };
  const key = await storeKey(body.deviceKey);
  const state = (await env.STORE.get(key, 'json')) || {
    subscription: null,
    reminders: [],
    createdAt: Date.now()
  };
  if (body.subscription && validSubscription(body.subscription)) {
    state.subscription = body.subscription;
  }
  return { body, key, state };
}

async function handleFetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET,POST,OPTIONS'
        }
      });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'rk-push', crons: 'every minute' });
    }

    if (request.method !== 'POST') return json({ error: 'not found' }, 404);

    if (url.pathname === '/api/register') {
      const loaded = await loadDevice(request, env);
      if (loaded.error) return json({ error: loaded.error }, 400);
      // A subscription was sent and it is broken -> say so instead of
      // silently keeping the old one.
      if (loaded.body.subscription && !validSubscription(loaded.body.subscription)) {
        return json({ error: 'invalid push subscription' }, 400);
      }
      if (!validSubscription(loaded.state.subscription)) {
        return json({ error: 'valid push subscription required' }, 400);
      }
      await env.STORE.put(loaded.key, JSON.stringify(loaded.state));
      return json({ ok: true });
    }

    if (url.pathname === '/api/sync') {
      const loaded = await loadDevice(request, env);
      if (loaded.error) return json({ error: loaded.error }, 400);
      loaded.state.reminders = mergeReminders(loaded.state.reminders, loaded.body.reminders);
      loaded.state.updatedAt = Date.now();
      await env.STORE.put(loaded.key, JSON.stringify(loaded.state));
      return json({ ok: true, count: loaded.state.reminders.length });
    }

    if (url.pathname === '/api/dismiss') {
      const loaded = await loadDevice(request, env);
      if (loaded.error) return json({ error: loaded.error }, 400);
      const { id, mode, snoozeMs } = loaded.body;
      const list = loaded.state.reminders || [];
      const idx = list.findIndex((r) => r.id === String(id));
      if (idx >= 0) {
        if (mode === 'snooze') {
          const ms = Math.max(30000, Math.min(Number(snoozeMs) || 300000, 24 * 3600000));
          list[idx].fireMs = Date.now() + ms;
          list[idx].chainStep = 0;
        } else {
          list.splice(idx, 1); // done or stopped -> stop the nudge chain
        }
        loaded.state.reminders = list;
        await env.STORE.put(loaded.key, JSON.stringify(loaded.state));
      }
      return json({ ok: true, remaining: loaded.state.reminders.length });
    }

    if (url.pathname === '/api/state') {
      const loaded = await loadDevice(request, env);
      if (loaded.error) return json({ error: loaded.error }, 400);
      return json({
        ok: true,
        count: (loaded.state.reminders || []).length,
        reminders: (loaded.state.reminders || []).map((r) => ({
          id: r.id, fireMs: r.fireMs, chainStep: r.chainStep
        }))
      });
    }

    if (url.pathname === '/api/test') {
      const loaded = await loadDevice(request, env);
      if (loaded.error) return json({ error: loaded.error }, 400);
      if (!validSubscription(loaded.state.subscription)) {
        return json({ error: 'no subscription stored yet' }, 400);
      }
      const siteUrl = (env.SITE_URL || '/').replace(/\/?$/, '/');
      const code = await sendPush(env, loaded.state.subscription, {
        web_push: 8030,
        notification: {
          title: 'ReminderKrunga test 🔔',
          body: 'Push server is connected — timed alarms will arrive like this.',
          navigate: siteUrl,
          silent: false,
          requireInteraction: true
        }
      });
      if (code && code !== 201 && code !== 200) {
        return json({ ok: false, status: code }, 502);
      }
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
}

async function handleScheduled(_event, env) {
  await sweep(env);
}

// worker.js turns { handleFetch, handleScheduled } into the default handler
// the Workers runtime wants (it rejects non-function module exports such as
// CHAIN/GRACE). test-local.js imports everything from here directly.
export {
  handleFetch,
  handleScheduled,
  mergeReminders,
  nudgePayload,
  processDevice,
  sweep,
  CHAIN,
  GRACE
};

/*
 * Local proof for the push server - no Apple account, no Cloudflare deploy.
 *
 *   node test-local.js
 *       Part 1: worker logic against an in-memory KV (fully offline).
 *
 *   node test-local.js http://127.0.0.1:8789
 *       Part 2: same flow against `wrangler dev` (real workerd runtime),
 *       proving web-push works under nodejs_compat and the cron endpoint fires.
 *
 * Both parts push REAL web-push encrypted messages. Part 1 to a local HTTPS
 * mock APNs receiver (self-signed test-cert.pfx, verification disabled only
 * inside this test process), part 2 to a public HTTPS echo endpoint, since
 * web-push only ever speaks https.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import webpush from 'web-push';
import {
  handleFetch,
  handleScheduled,
  mergeReminders,
  nudgePayload,
  CHAIN,
  GRACE
} from './worker-core.js';

const BASE = process.argv[2] || null;
const MOCK_PORT = 9347;
const MAX_REMINDERS = 200;
// Public echo used by part 2 (workerd cannot reach our self-signed mock).
// Any 2xx counts as success (web-push-lib.js: statusCode 200-299 resolves).
// Notes: httpbingo /post->402 to scripts, postman-echo /post->500 on binary
// bodies - webhook.site accepts anything and is under our control.
const ECHO_URL = process.env.RK_ECHO_URL || 'https://webhook.site/d4ed1144-eb14-40f4-9986-159ea9399ea4';

// Local self-signed cert: verification is disabled for THIS process only
// (part 1's in-process worker calls out to the mock). Never in production.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) passed += 1;
  else { failures.push(msg); console.log('  FAIL: ' + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(60);
  }
  return await fn();
}

/* ------------------------- mock APNs receiver ---------------------------- */
const received = [];
let mockStatus = 201;
const mockHandler = (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(mockStatus, { 'content-type': 'application/json' });
    res.end(mockStatus === 201 ? '{"mock":true}' : '');
  });
};
const mock = https.createServer({
  pfx: fs.readFileSync(new URL('./test-cert.pfx', import.meta.url)),
  passphrase: 'rk-test'
}, mockHandler);
await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

function fakeSubscription() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://127.0.0.1:${MOCK_PORT}/push`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url')
    }
  };
}

/** Part 2 subscription: a real public HTTPS endpoint web-push can reach. */
function echoSubscription() {
  const sub = fakeSubscription();
  sub.endpoint = ECHO_URL;
  return sub;
}

function memStore() {
  const map = new Map();
  return {
    map,
    async get(k, t) {
      const v = map.get(k);
      if (v == null) return null;
      return t === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { map.set(k, String(v)); },
    async delete(k) { map.delete(k); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...map.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
        list_complete: true
      };
    }
  };
}

const vapid = webpush.generateVAPIDKeys();
const env = {
  STORE: memStore(),
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:test@example.com',
  SITE_URL: 'https://example.test/ReminderKrunga/'
};

function makeApi(base, localEnv) {
  return async (path, body) => {
    if (base) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    }
    const res = await handleFetch(
      new Request('http://rk.local' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }),
      localEnv
    );
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

async function triggerCron(base, localEnv) {
  if (base) {
    const res = await fetch(base + '/__scheduled?cron=' + encodeURIComponent('* * * * *'));
    await sleep(350); // let async sends flush
    return res.status;
  }
  await handleScheduled({}, localEnv);
  return 200;
}

const cronFor = (base) => () => triggerCron(base, env);

/* ---------------------------- unit checks -------------------------------- */
function unitChecks() {
  const keep = mergeReminders([{ id: 'x', fireMs: 1000, chainStep: 2 }], [{ id: 'x', fireMs: 1000, title: 't' }]);
  check(keep.length === 1 && keep[0].chainStep === 2, 'merge keeps chainStep when fireMs unchanged');

  const moved = mergeReminders([{ id: 'x', fireMs: 1000, chainStep: 2 }], [{ id: 'x', fireMs: 2000, title: 't' }]);
  check(moved[0].chainStep === 0, 'merge resets chainStep when fireMs moved');

  const filtered = mergeReminders([], [
    { id: 'x', fireMs: 1000, done: true },
    { fireMs: Number('nope') },
    { id: 'y', fireMs: 3000 },
    { id: 'z', fireMs: 2000 }
  ]);
  check(filtered.length === 2 && filtered[0].id === 'z' && filtered[1].id === 'y',
    'merge drops done/invalid and sorts by time');

  const many = mergeReminders([], Array.from({ length: 300 }, (_, i) => ({ id: 'r' + i, fireMs: i })));
  check(many.length === MAX_REMINDERS, `merge caps at ${MAX_REMINDERS} reminders`);

  check(CHAIN.length === 4 && CHAIN[0] === 0 && CHAIN[1] === 60000 &&
    CHAIN[2] === 180000 && CHAIN[3] === 420000, 'chain offsets are 0/+1m/+3m/+7m');
  check(GRACE === 600000, 'grace window is 10 minutes');

  const p0 = nudgePayload({ id: 'a b', title: 'Wake up', note: 'Gym' }, 0, 'https://x.app/', 3);
  check(p0.web_push === 8030, 'declarative web_push magic value 8030');
  check(p0.notification.navigate.includes('r=a%20b') && p0.notification.navigate.includes('step=0'),
    'navigate deep-links to the reminder (encoded id + step)');
  check(p0.notification.app_badge === '3', 'app_badge carries pending count');
  check(p0.notification.silent === false, 'nudge is audible');
  check(p0.notification.title === 'Wake up', 'title comes from the reminder');
  check(p0.notification.body === 'Gym', 'first nudge uses the note as body');

  const p3 = nudgePayload({ id: 'a', title: 'T' }, 3, 'https://x.app/', 1);
  check(/Last call/.test(p3.notification.body), 'final nudge says "Last call"');
}

/* ------------------------- end-to-end flow ------------------------------- */
async function flow(api, label, deviceKey, cron) {
  let r = await api('/api/register', { deviceKey, subscription: fakeSubscription() });
  check(r.status === 200 && r.data && r.data.ok, `${label}: register accepts subscription`);

  r = await api('/api/register', { deviceKey, subscription: { endpoint: 'ftp://nope' } });
  check(r.status === 400, `${label}: register rejects bad endpoint`);

  r = await api('/api/state', { deviceKey });
  check(r.data.count === 0, `${label}: fresh device starts empty`);

  // Due right now -> first nudge on the next pass.
  const id = 'rem-' + deviceKey.slice(0, 8);
  const fireMs = Date.now() - 2000;
  r = await api('/api/sync', { deviceKey, reminders: [{ id, title: 'Test reminder', note: 'Nudge me', fireMs }] });
  check(r.status === 200 && r.data.count === 1, `${label}: sync stores the reminder`);

  let base = received.length;
  await cron();
  await waitUntil(() => received.length >= base + 1, 5000);
  check(received.length === base + 1, `${label}: due reminder gets its first nudge`);

  const wire = received[received.length - 1];
  check(wire.headers['content-encoding'] === 'aes128gcm', `${label}: payload uses aes128gcm`);
  // http_ece (what web-push encrypts with) framing:
  // salt(16) | rs(4) | keyidLen(1) | keyid(=ephemeral pubkey) | ciphertext
  const b = wire.body;
  const rs = b.length > 21 ? b.readUInt32BE(16) : 0;
  const idLen = b.length > 21 ? b[20] : 0;
  check(rs === 4096, `${label}: record size field is 4096 (got ${rs})`);
  check(idLen === 65, `${label}: keyid is the 65B sender public key (got ${idLen})`);
  check(b.length > 21 + idLen, `${label}: ciphertext present after the header`);
  check(/^vapid /i.test(wire.headers.authorization || ''), `${label}: request is VAPID signed`);
  check((wire.headers.ttl || '') !== '', `${label}: TTL header set`);
  check(wire.body.length > 50, `${label}: body is encrypted, not plaintext`);

  // Next step is +60s away: another pass must not double-send.
  await cron();
  check(received.length === base + 1, `${label}: no double send while next step is in the future`);

  // Re-sync with identical fireMs must NOT restart the chain.
  await api('/api/sync', { deviceKey, reminders: [{ id, title: 'Test reminder', note: 'Nudge me', fireMs }] });
  await cron();
  check(received.length === base + 1, `${label}: chainStep survives an identical re-sync`);

  // Move the time back 65s: chain restarts (catch-up nudge fires now), then
  // step 2 (+60s) is already 5s overdue on the very next pass.
  const fire2 = Date.now() - 65000;
  await api('/api/sync', { deviceKey, reminders: [{ id, title: 'Test reminder', note: 'Nudge me', fireMs: fire2 }] });
  await cron();
  await waitUntil(() => received.length >= base + 2, 5000);
  check(received.length === base + 2, `${label}: reschedule restarts chain with catch-up nudge`);

  await cron();
  await waitUntil(() => received.length >= base + 3, 5000);
  check(received.length === base + 3, `${label}: step 2 fires once +60s is due`);

  // Snooze pushes the fire time into the future -> silent until then.
  await api('/api/dismiss', { deviceKey, id, mode: 'snooze', snoozeMs: 300000 });
  await cron();
  check(received.length === base + 3, `${label}: snoozed reminder stays silent`);

  // Done removes it from the chain entirely.
  await api('/api/dismiss', { deviceKey, id, mode: 'done' });
  await cron();
  check(received.length === base + 3, `${label}: done reminder stops the chain`);
  r = await api('/api/state', { deviceKey });
  check(r.data.count === 0, `${label}: done reminder removed from store`);

  // Manual test push.
  await api('/api/test', { deviceKey });
  await waitUntil(() => received.length >= base + 4, 5000);
  check(received.length === base + 4, `${label}: /api/test sends immediately`);

  // A reminder 11 minutes past its first step is stale: never blasted, cleaned up.
  await api('/api/sync', {
    deviceKey,
    reminders: [{ id: 'stale', title: 'Old thing', fireMs: Date.now() - 11 * 60000 }]
  });
  await cron();
  check(received.length === base + 4, `${label}: stale (11 min old) reminder is not blasted`);
  r = await api('/api/state', { deviceKey });
  check(r.data.count === 0, `${label}: stale reminder cleaned from store`);
}

async function deadEndpointCleanup(api, label, deviceKey, cron) {
  mockStatus = 404;
  try {
    await api('/api/sync', {
      deviceKey,
      subscription: fakeSubscription(),
      reminders: [{ id: 'gone', title: 'T', fireMs: Date.now() - 1000 }]
    });
    await cron();
    await sleep(250);
    const r = await api('/api/state', { deviceKey });
    check(r.data.count === 0, `${label}: 404 endpoint drops the whole device`);
  } finally {
    mockStatus = 201;
  }
}

/* -------------------- part 2: real workerd runtime ----------------------- */
/**
 * Under `wrangler dev` we cannot swap in a local mock, so this flow uses a
 * public HTTPS echo endpoint. The observable signal that web-push really
 * worked is chainStep: it only advances when the send returned success.
 */
async function flowWorkerd(api, cron, deviceKey) {
  let r = await api('/api/register', { deviceKey, subscription: echoSubscription() });
  check(r.status === 200 && r.data && r.data.ok, 'workerd: register accepted');

  const id = 'wd-' + deviceKey.slice(0, 6);
  r = await api('/api/sync', { deviceKey, reminders: [{ id, title: 'Workerd test', fireMs: Date.now() - 2000 }] });
  check(r.status === 200 && r.data.count === 1, 'workerd: sync stores reminder');

  await cron();
  const advanced = await waitUntil(async () => {
    const st = (await api('/api/state', { deviceKey })).data;
    return !!(st.reminders[0] && st.reminders[0].chainStep === 1);
  }, 8000);
  check(advanced, 'workerd: cron sent a real https push (chainStep -> 1)');

  await cron();
  let st = (await api('/api/state', { deviceKey })).data;
  check(st.reminders[0] && st.reminders[0].chainStep === 1,
    'workerd: no re-send while next step is in the future');

  r = await api('/api/dismiss', { deviceKey, id, mode: 'done' });
  st = (await api('/api/state', { deviceKey })).data;
  check(r.status === 200 && st.count === 0, 'workerd: dismiss done clears the chain');

  r = await api('/api/test', { deviceKey });
  check(r.status === 200 && r.data && r.data.ok, 'workerd: /api/test sends immediately');

  // Bad payload handling must not crash the worker.
  const bad = await fetch(BASE + '/api/sync', { method: 'POST', body: 'not-json' });
  check(bad.status === 400, 'workerd: malformed body -> 400, not a crash');
}

/* -------------------------------- run ------------------------------------ */
console.log('part 1: worker logic (in-memory KV)');
unitChecks();
await flow(makeApi(null, env), 'memory', 'device-mem-' + Math.random().toString(36).slice(2, 8), cronFor(null));
await deadEndpointCleanup(makeApi(null, env), 'memory', 'device-dead-' + Math.random().toString(36).slice(2, 8), cronFor(null));

if (BASE) {
  console.log('part 2: wrangler dev (' + BASE + ')');
  await flowWorkerd(makeApi(BASE, env), cronFor(BASE), 'device-wd-' + Math.random().toString(36).slice(2, 8));
} else {
  console.log('(part 2 skipped - pass the wrangler dev URL to run it)');
}

mock.close();
const total = passed + failures.length;
console.log('');
console.log(failures.length === 0
  ? `=== ${passed}/${total} checks passed ===`
  : `=== ${passed}/${total} checks passed, ${failures.length} FAILED ===`);
process.exit(failures.length === 0 ? 0 : 1);

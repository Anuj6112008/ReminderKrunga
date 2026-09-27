/*
 * ReminderKrunga service worker.
 *
 * Two jobs:
 *  1. Offline shell - the app opens even with no network.
 *  2. Web Push - renders both the declarative format (iOS 18.4+, works even
 *     if this file gets evicted) and the classic "your script shows it" format.
 *
 * Notification tap -> opens/navigates to the reminder URL carried in the
 * payload ("navigate"), so a locked phone goes straight to the alarm screen.
 */
const CACHE = 'rk-shell-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './icon.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './manifest.webmanifest',
  './reminder_tone.wav'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // Navigations: network first so a deployed fix is picked up on the next
  // open, cache as the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Everything else: cache first, refresh in the background (stale-while-
  // revalidate) so an offline alarm still has its tone.
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});

/** Turn any supported payload shape into one notification description. */
function normalizePush(json, fallbackText) {
  // Declarative Web Push (W3C): { web_push: 8030, notification: {...} }
  if (json && json.notification && json.notification.title) {
    const n = json.notification;
    return {
      title: String(n.title),
      body: String(n.body || ''),
      icon: n.icon || './icon.png',
      badge: n.badge || './icon.png',
      tag: n.tag,
      silent: n.silent === true,
      navigate: n.navigate || './'
    };
  }
  // Classic app format: { title, body, url / navigate, tag, ... }
  if (json && (json.title || json.body)) {
    return {
      title: String(json.title || 'ReminderKrunga'),
      body: String(json.body || ''),
      icon: json.icon || './icon.png',
      badge: json.badge || './icon.png',
      tag: json.tag,
      silent: json.silent === true,
      navigate: json.url || json.navigate || './'
    };
  }
  return {
    title: 'ReminderKrunga',
    body: fallbackText ? String(fallbackText).slice(0, 300) : 'You have a reminder',
    icon: './icon.png',
    badge: './icon.png',
    silent: false,
    navigate: './'
  };
}

self.addEventListener('push', (event) => {
  let json = null;
  let text = '';
  try {
    if (event.data) {
      text = event.data.text();
      try { json = JSON.parse(text); } catch (e) { json = null; }
    }
  } catch (e) { /* ignore */ }

  const payload = normalizePush(json, text);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      silent: payload.silent,
      requireInteraction: true,
      data: { navigate: payload.navigate }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = data.navigate || './';

  // Action buttons (Snooze / Done) ride on the URL so the app can apply them
  // on open even when it was not running.
  if (event.action) {
    try {
      const url = new URL(target, self.location.origin);
      url.searchParams.set('act', event.action);
      target = url.toString();
    } catch (e) { /* ignore */ }
  }

  event.waitUntil((async () => {
    try {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (!event.action) {
        for (const client of windows) {
          if ('focus' in client) { await client.focus(); return; }
        }
      }
      await self.clients.openWindow(target);
    } catch (e) { /* ignore */ }
  })());
});

const LocalNotifications = window.Capacitor?.Plugins?.LocalNotifications || null;
const Preferences = window.Capacitor?.Plugins?.Preferences || null;
const NativeSettings = window.Capacitor?.Plugins?.NativeSettings || null;
const Capacitor = window.Capacitor || { getPlatform: () => 'web' };

const STORAGE_KEY = 'reminderkrunga_data_v1';
const SETTINGS_KEY = 'reminderkrunga_settings_v1';
const ONBOARD_KEY = 'reminderkrunga_onboarded_v1';
const NOTIF_ID_START = 10000;
const NOTIFICATION_SOUND = 'reminder_tone.wav';

// Notification action buttons (Snooze / Done) on the notification itself
const ACTION_TYPE_ID = 'reminder_reminder_actions';

// Repeat-alert chain: extra notifications after the first one, so the phone
// keeps nagging until the user actually responds (works even if app is closed).
// Chain IDs live in their own range so they can never collide with reminder IDs:
//   chainId = CHAIN_ID_BASE + reminderId * 100 + slot
const CHAIN_ID_BASE = 1000000;
const CHAIN_SLOT_MS = 45000;      // gap between repeated alerts
const MAX_CHAIN_SLOTS = 9;        // Android exact-alarm quota safety cap

const DEFAULT_SETTINGS = {
  theme: 'light',
  alarmSound: true,
  vibration: true,
  chainAlerts: true,
  ringMinutes: 5,
  snoozeMinutes: 5
};

let reminders = [];
let settings = { ...DEFAULT_SETTINGS };
let currentFilter = 'all';
let searchQuery = '';
let editingId = null;
let pendingDeleteId = null;
let lastDeleted = null;

const $ = (id) => document.getElementById(id);

const listEl = $('remindersList');
const headerSub = $('headerSub');
const searchInput = $('searchInput');
const filterChips = $('filterChips');
const fabAdd = $('fabAdd');
const themeToggle = $('themeToggle');
const themeIcon = $('themeIcon');

const modalOverlay = $('modalOverlay');
const modalTitle = $('modalTitle');
const inputTitle = $('inputTitle');
const inputDesc = $('inputDesc');
const inputDateTime = $('inputDateTime');
const inputCategory = $('inputCategory');
const inputPriority = $('inputPriority');
const inputRepeat = $('inputRepeat');
const saveBtn = $('saveBtn');
const cancelBtn = $('cancelBtn');
const closeModalBtn = $('closeModal');

const confirmOverlay = $('confirmOverlay');
const confirmTitle = $('confirmTitle');
const confirmMsg = $('confirmMsg');
const confirmYes = $('confirmYes');
const confirmNo = $('confirmNo');

const toastEl = $('toast');
const toastMsg = $('toastMsg');
const toastAction = $('toastAction');

// Alarm screen
const alarmScreen = $('alarmScreen');
const alarmTime = $('alarmTime');
const alarmTitle = $('alarmTitle');
const alarmDesc = $('alarmDesc');
const alarmStatus = $('alarmStatus');
const alarmHint = $('alarmHint');
const alarmSnoozeBtn = $('alarmSnooze');
const alarmStopBtn = $('alarmStop');
const alarmDoneBtn = $('alarmDone');
const alarmAudio = $('alarmAudio');

// Settings
const settingsOverlay = $('settingsOverlay');
const settingsBtn = $('settingsBtn');
const closeSettingsBtn = $('closeSettings');
const setAlarmSound = $('setAlarmSound');
const setVibration = $('setVibration');
const setChainAlerts = $('setChainAlerts');
const setRingMinutes = $('setRingMinutes');
const setSnoozeMinutes = $('setSnoozeMinutes');
const testSoundBtn = $('testSoundBtn');
const exportBtn = $('exportBtn');
const importBtn = $('importBtn');

// Backup
const backupOverlay = $('backupOverlay');
const backupTitle = $('backupTitle');
const backupHint = $('backupHint');
const backupText = $('backupText');
const backupFile = $('backupFile');
const backupPrimary = $('backupPrimary');
const backupSecondary = $('backupSecondary');
const closeBackupBtn = $('closeBackup');

// Insights
const nextUpTitle = $('nextUpTitle');
const nextUpTime = $('nextUpTime');
const nextUpFill = $('nextUpFill');
const progressText = $('progressText');
const progressSub = $('progressSub');
const progressFill = $('progressFill');

let toastTimer = null;
let toastActionHandler = null;

function showToast(msg, type = 'info', action = null) {
  toastMsg.textContent = msg;
  if (type === 'error') toastEl.style.background = '#ef4444';
  else if (type === 'success') toastEl.style.background = '#10b981';
  else toastEl.style.background = '';

  if (action && typeof action.onClick === 'function') {
    toastAction.textContent = action.label || 'Undo';
    toastAction.classList.add('show');
    toastEl.classList.add('has-action');
    toastActionHandler = action.onClick;
  } else {
    toastAction.classList.remove('show');
    toastEl.classList.remove('has-action');
    toastActionHandler = null;
  }

  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    toastAction.classList.remove('show');
    toastEl.classList.remove('has-action');
    toastActionHandler = null;
  }, action ? 5000 : 2500);
}

toastAction.addEventListener('click', () => {
  const handler = toastActionHandler;
  clearTimeout(toastTimer);
  toastEl.classList.remove('show', 'has-action');
  toastAction.classList.remove('show');
  toastActionHandler = null;
  if (handler) handler();
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function toLocalInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultDateTime() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 10);
  return toLocalInput(d);
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const now = new Date();

  const isToday = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) return `Today, ${timeStr}`;
  if (isTomorrow) return `Tomorrow, ${timeStr}`;

  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function timeUntil(iso) {
  const target = new Date(iso);
  const now = new Date();
  const diff = target - now;

  if (diff < 0) {
    const past = Math.abs(diff);
    if (past < 60000) return 'Just passed';
    if (past < 3600000) return `${Math.floor(past / 60000)}m overdue`;
    if (past < 86400000) return `${Math.floor(past / 3600000)}h overdue`;
    return `${Math.floor(past / 86400000)}d overdue`;
  }

  if (diff < 60000) return 'in <1m';
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h`;
  return `in ${Math.floor(diff / 86400000)}d`;
}

function isOverdue(iso) {
  return new Date(iso) < new Date();
}

function getCategoryIcon(cat) {
  const map = {
    work: '💼',
    personal: '👤',
    health: '💊',
    study: '📚',
    other: '📌'
  };
  return map[cat] || '📌';
}

function getRepeatLabel(rep) {
  const map = {
    none: '',
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly'
  };
  return map[rep] || '';
}

async function loadData() {
  try {
    if (Preferences) {
      const { value } = await Preferences.get({ key: STORAGE_KEY });
      reminders = value ? JSON.parse(value) : [];
    } else {
      const raw = localStorage.getItem(STORAGE_KEY);
      reminders = raw ? JSON.parse(raw) : [];
    }
  } catch (e) {
    console.error('Load reminders failed:', e);
    reminders = [];
  }

  try {
    if (Preferences) {
      const { value: s } = await Preferences.get({ key: SETTINGS_KEY });
      settings = { ...DEFAULT_SETTINGS, ...(s ? JSON.parse(s) : {}) };
    } else {
      const raw = localStorage.getItem(SETTINGS_KEY);
      settings = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    }
  } catch (e) {
    console.error('Load settings failed:', e);
    settings = { ...DEFAULT_SETTINGS };
  }

  settings.ringMinutes = Math.max(1, parseInt(settings.ringMinutes, 10) || 5);
  settings.snoozeMinutes = Math.max(1, parseInt(settings.snoozeMinutes, 10) || 5);

  applyTheme();
  render();
}

async function saveData() {
  try {
    if (Preferences) {
      await Preferences.set({
        key: STORAGE_KEY,
        value: JSON.stringify(reminders)
      });
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders));
    }
  } catch (e) {
    console.error('Save failed:', e);
  }
}

async function saveSettings() {
  try {
    if (Preferences) {
      await Preferences.set({
        key: SETTINGS_KEY,
        value: JSON.stringify(settings)
      });
    } else {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
  } catch (e) {
    console.error('Save settings failed:', e);
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', settings.theme);
  themeIcon.textContent = settings.theme === 'dark' ? '☀️' : '🌙';
}

async function toggleTheme() {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  await saveSettings();
}

async function setupNotificationChannel() {
  if (!LocalNotifications || Capacitor.getPlatform() !== 'android') return;

  try {
    await LocalNotifications.createChannel({
      id: 'reminders',
      name: 'Reminders',
      description: 'Reminder notifications',
      importance: 5,
      visibility: 1,
      sound: NOTIFICATION_SOUND,
      vibration: true
    });
  } catch (e) {
    console.error('Channel setup failed:', e);
  }
}

// Silent check + request (used as a safety net before scheduling,
// in case the user skipped the onboarding permission screens)
async function ensureNotificationPermission() {
  if (!LocalNotifications) return true;

  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display === 'granted') return true;

    const result = await LocalNotifications.requestPermissions();
    return result.display === 'granted';
  } catch (e) {
    console.error('Permission check failed:', e);
    return true; // don't block scheduling on unexpected errors
  }
}

/* ============================================================
   SCHEDULING ENGINE
   Every reminder owns 11 possible native notifications:
     · main   -> reminder.id            (repeats natively when set)
     · snooze -> 95000000 + id          (one-shot after user snoozes)
     · chain  -> 1000000 + id*100 + n   (repeat alerts while unanswered)
   ============================================================ */

const SNOOZE_ID_BASE = 95000000;

function isRepeating(r) {
  return !!r.repeat && r.repeat !== 'none';
}

function snoozeIdFor(id) {
  return SNOOZE_ID_BASE + id;
}

function chainIdFor(id, slot) {
  return CHAIN_ID_BASE + id * 100 + slot;
}

function chainSlotCount() {
  const wanted = Math.ceil((settings.ringMinutes * 60000) / CHAIN_SLOT_MS);
  return Math.max(1, Math.min(MAX_CHAIN_SLOTS, wanted));
}

function addOccurrence(r, fromMs) {
  const d = new Date(fromMs);
  if (r.repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (r.repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (r.repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  else return fromMs + 86400000;
  return d.getTime();
}

/** Most recent occurrence at or before now (one-shot = its own time). */
function currentOccurrenceMs(r) {
  const now = Date.now();
  const base = new Date(r.time).getTime();
  if (!isRepeating(r)) return base;

  let t = base;
  for (let i = 0; i < 3000; i++) {
    const next = addOccurrence(r, t);
    if (next > now) break;
    t = next;
  }
  return t;
}

/** Next occurrence strictly in the future. */
function nextOccurrenceMs(r) {
  const now = Date.now();
  const cur = currentOccurrenceMs(r);
  if (cur > now) return cur;
  if (!isRepeating(r)) return cur;
  return addOccurrence(r, cur);
}

/** When this reminder should ring next, honouring an active snooze. */
function pendingFireMs(r) {
  if (r.snoozedUntil) {
    const s = new Date(r.snoozedUntil).getTime();
    if (Number.isFinite(s)) return s;
  }
  return currentOccurrenceMs(r);
}

function repeatUnit(rep) {
  return rep === 'daily' ? 'day' : rep === 'weekly' ? 'week' : 'month';
}

function makeNotification(r, opts = {}) {
  const n = {
    id: opts.id != null ? opts.id : r.id,
    title: opts.title || r.title,
    body: opts.body || r.description || 'Time for your reminder!',
    channelId: 'reminders',
    sound: NOTIFICATION_SOUND,
    smallIcon: 'ic_stat_icon',
    iconColor: '#6366f1',
    actionTypeId: ACTION_TYPE_ID,
    autoCancel: opts.autoCancel !== false,
    extra: { reminderId: r.id, kind: opts.kind || 'main' },
    schedule: { allowWhileIdle: true }
  };

  if (opts.every) {
    n.schedule.every = opts.every;
    n.schedule.on = opts.on;
  } else if (opts.at) {
    n.schedule.at = new Date(opts.at);
  }

  return n;
}

/** Cancel main + snooze + every possible chain slot for a reminder. */
async function cancelReminderNotifications(id) {
  if (!LocalNotifications) return;

  const ids = [id, snoozeIdFor(id)];
  for (let slot = 1; slot <= MAX_CHAIN_SLOTS; slot++) ids.push(chainIdFor(id, slot));

  try {
    await LocalNotifications.cancel({
      notifications: ids.map(nid => ({ id: nid }))
    });
  } catch (e) {
    console.warn('Cancel notification failed:', e);
  }
}

/** Book the repeating nudge notifications for an upcoming fire time. */
async function scheduleChain(r, atMs) {
  if (!LocalNotifications || !settings.chainAlerts) return;
  if (!atMs) return;

  // atMs may already be in the past (an alarm that is ringing right now) —
  // every slot is evaluated on its own, so future ones still get booked.
  const count = chainSlotCount();
  const list = [];

  for (let slot = 1; slot <= count; slot++) {
    const at = atMs + slot * CHAIN_SLOT_MS;
    if (at <= Date.now()) continue;

    list.push(makeNotification(r, {
      id: chainIdFor(r.id, slot),
      at,
      kind: 'chain',
      autoCancel: false,
      title: `⏰ ${r.title}`,
      body: 'Still waiting for you — swipe and tap Snooze or Done.'
    }));
  }

  if (!list.length) return;

  try {
    await LocalNotifications.schedule({ notifications: list });
  } catch (e) {
    console.warn('Chain schedule failed:', e);
  }
}

/** Full (re)schedule of everything a reminder owns. Safe to call any time. */
async function scheduleReminder(r) {
  if (!LocalNotifications) return;

  await ensureNotificationPermission();
  await cancelReminderNotifications(r.id);

  const now = Date.now();
  const snoozeMs = r.snoozedUntil ? new Date(r.snoozedUntil).getTime() : NaN;
  const snoozeActive = Number.isFinite(snoozeMs) && snoozeMs > now;

  try {
    // 1. Snoozed alert (own id so it never clashes with the repeating series)
    if (snoozeActive) {
      await LocalNotifications.schedule({
        notifications: [makeNotification(r, {
          id: snoozeIdFor(r.id),
          at: snoozeMs,
          kind: 'snooze',
          title: `😴 Snoozed · ${r.title}`,
          body: `Ring again now — snoozed ${settings.snoozeMinutes} min ago.`
        })]
      });
    }

    // 2. Base alert
    if (isRepeating(r)) {
      const t = new Date(r.time);
      await LocalNotifications.schedule({
        notifications: [makeNotification(r, {
          id: r.id,
          every: repeatUnit(r.repeat),
          on: { hour: t.getHours(), minute: t.getMinutes() }
        })]
      });
    } else if (new Date(r.time).getTime() > now) {
      await LocalNotifications.schedule({
        notifications: [makeNotification(r, {
          id: r.id,
          at: new Date(r.time).getTime()
        })]
      });
    }

    // 3. Repeat alerts up to the nearest moment this reminder can ring
    const chainAt = snoozeActive ? snoozeMs : nextOccurrenceMs(r);
    await scheduleChain(r, chainAt);
  } catch (e) {
    console.error('Schedule error:', e);
    throw e;
  }
}

/** Only refresh the repeat alerts (keeps the native repeating series intact). */
async function armChains(r) {
  if (!LocalNotifications || !settings.chainAlerts || r.done) return;

  const now = Date.now();
  const snoozeMs = r.snoozedUntil ? new Date(r.snoozedUntil).getTime() : NaN;

  let at = NaN;
  if (Number.isFinite(snoozeMs) && snoozeMs > now) {
    at = snoozeMs;
  } else {
    const cur = currentOccurrenceMs(r);
    // Still inside the ring window -> keep nudging about this very occurrence
    at = (now - cur <= ringGraceMs()) ? cur : nextOccurrenceMs(r);
  }

  const stale = [];
  for (let slot = 1; slot <= MAX_CHAIN_SLOTS; slot++) stale.push({ id: chainIdFor(r.id, slot) });

  try {
    await LocalNotifications.cancel({ notifications: stale });
  } catch (e) { /* ignore */ }

  await scheduleChain(r, at);
}

async function cancelNotification(id) {
  await cancelReminderNotifications(id);
}

/* ============================================================
   ALARM — rings full screen until the user presses a button
   ============================================================ */

let alarmState = null;      // { id, fireMs, untilMs }
let vibrateTimer = null;
let wakeLock = null;

function ringGraceMs() {
  return settings.ringMinutes * 60000 + 60000;
}

function getReminder(id) {
  return reminders.find(r => r.id === id) || null;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* not supported / not allowed */ }
}

async function releaseWakeLock() {
  try { if (wakeLock) await wakeLock.release(); } catch (e) { /* ignore */ }
  wakeLock = null;
}

function startRinging() {
  if (settings.alarmSound) {
    try {
      alarmAudio.loop = true;
      alarmAudio.currentTime = 0;
      const p = alarmAudio.play();
      if (p && typeof p.catch === 'function') {
        p.then(() => guardWhileRinging())
         .catch(() => {
           alarmHint.textContent = 'Tap the screen to start the sound';
         });
      }
    } catch (e) { /* ignore */ }
  }

  if (settings.vibration && navigator.vibrate) {
    const pattern = [700, 400, 700, 400, 700, 400];
    const length = pattern.reduce((a, b) => a + b, 0);
    try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    clearInterval(vibrateTimer);
    vibrateTimer = setInterval(() => {
      try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }, length);
  }

  requestWakeLock();
}

function stopRinging() {
  try {
    alarmAudio.pause();
    alarmAudio.currentTime = 0;
  } catch (e) { /* ignore */ }

  clearInterval(vibrateTimer);
  vibrateTimer = null;

  if (navigator.vibrate) {
    try { navigator.vibrate(0); } catch (e) { /* ignore */ }
  }

  releaseWakeLock();
}

/**
 * A play() promise can resolve *after* the user already dismissed the alarm
 * (autoplay was blocked, they tapped a button). Without this the tone would
 * keep looping with no screen to stop it.
 */
function guardWhileRinging() {
  if (!alarmState) {
    try {
      alarmAudio.pause();
      alarmAudio.currentTime = 0;
    } catch (e) { /* ignore */ }
  }
}

function updateAlarmStatus() {
  if (!alarmState) return;
  const left = Math.max(0, alarmState.untilMs - Date.now());
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  alarmStatus.textContent = `Ringing… stops in ${mins}:${pad(secs)}`;
}

function hideAlarm() {
  stopRinging();
  alarmScreen.classList.remove('active', 'ringing');
  alarmState = null;
}

async function fireAlarm(r, fireMs) {
  if (alarmState) return;

  // Reserve the slot synchronously so a second tick can't fire another one.
  alarmState = {
    id: r.id,
    fireMs,
    untilMs: Date.now() + settings.ringMinutes * 60000
  };

  r.lastRingKey = String(fireMs);
  saveData();

  // The full screen alarm takes over — silence the native repeat alerts.
  cancelReminderNotifications(r.id);

  alarmTime.textContent = new Date(fireMs)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  alarmTitle.textContent = r.title;
  alarmDesc.textContent = r.description || '';
  alarmSnoozeBtn.textContent = `Snooze ${settings.snoozeMinutes} min`;
  alarmHint.textContent = settings.chainAlerts
    ? 'Keeps ringing until you tap a button'
    : 'Tap a button to silence the alarm';

  alarmScreen.classList.add('active', 'ringing');
  updateAlarmStatus();
  startRinging();
}

/** Called every second + whenever the app comes back to the foreground. */
function alarmTick() {
  const now = Date.now();

  if (alarmState) {
    if (now >= alarmState.untilMs) {
      const r = getReminder(alarmState.id);
      hideAlarm();
      if (r) {
        r.snoozedUntil = null;
        saveData();
        scheduleReminder(r);
      }
      showToast('Alarm stopped automatically — open the reminder when you are ready');
    } else {
      updateAlarmStatus();
    }
    return;
  }

  const grace = ringGraceMs();

  for (const r of reminders) {
    if (r.done) continue;

    let t = pendingFireMs(r);

    // Forget snoozes that were never answered
    if (r.snoozedUntil && now > t + grace) {
      r.snoozedUntil = null;
      saveData();
      t = currentOccurrenceMs(r);
    }

    if (now >= t && now - t <= grace && r.lastRingKey !== String(t)) {
      fireAlarm(r, t);
      return;
    }
  }
}

async function snoozeReminder(r) {
  const ms = settings.snoozeMinutes * 60000;
  r.snoozedUntil = new Date(Date.now() + ms).toISOString();
  r.snoozeCount = (r.snoozeCount || 0) + 1;
  r.lastRingKey = null;

  await saveData();
  await scheduleReminder(r);
  render();
  showToast(`Snoozed for ${settings.snoozeMinutes} min ⏳`, 'success');
}

async function stopAlarmOnly() {
  const r = alarmState ? getReminder(alarmState.id) : null;
  hideAlarm();
  if (r) {
    r.snoozedUntil = null;
    await saveData();
    await scheduleReminder(r);
  }
  showToast('Alarm silenced — still on your list');
}

async function doneFromAlarm() {
  const r = alarmState ? getReminder(alarmState.id) : null;
  hideAlarm();
  if (r && !r.done) {
    await toggleDone(r.id);
    showToast('Done! Great job 🎉', 'success');
  }
}

alarmSnoozeBtn.addEventListener('click', async () => {
  const r = alarmState ? getReminder(alarmState.id) : null;
  hideAlarm();
  if (r) await snoozeReminder(r);
});

alarmStopBtn.addEventListener('click', () => {
  stopAlarmOnly();
});

alarmDoneBtn.addEventListener('click', () => {
  doneFromAlarm();
});

// Autoplay can be blocked: first tap on the alarm screen starts the sound.
alarmScreen.addEventListener('pointerdown', () => {
  if (alarmState && settings.alarmSound && alarmAudio.paused) {
    alarmAudio.play().then(() => {
      guardWhileRinging();
      if (alarmState) {
        alarmHint.textContent = 'Keeps ringing until you tap a button';
      }
    }).catch(() => { /* still blocked */ });
  }
});

function render() {
  const filtered = getFilteredReminders();

  const pending = reminders.filter(r => !r.done).length;
  const done = reminders.filter(r => r.done).length;
  headerSub.textContent = `${pending} pending · ${done} done`;

  renderInsights();

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">No reminders</div>
        <div class="empty-sub">
          ${searchQuery
            ? 'Try a different search'
            : currentFilter !== 'all'
              ? 'Nothing in this filter'
              : 'Tap + to add your first reminder'}
        </div>
      </div>
    `;
    return;
  }

  filtered.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ta = new Date(a.time).getTime();
    const tb = new Date(b.time).getTime();
    return a.done ? tb - ta : ta - tb;
  });

  listEl.innerHTML = filtered.map(renderCard).join('');
}

function todayStats() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const s = start.getTime();
  const e = end.getTime();

  let due = 0;
  let done = 0;

  for (const r of reminders) {
    const t = r.snoozedUntil
      ? new Date(r.snoozedUntil).getTime()
      : (isRepeating(r) ? currentOccurrenceMs(r) : new Date(r.time).getTime());

    if (!Number.isFinite(t) || t < s || t > e) continue;
    due++;
    if (r.done) done++;
  }

  return { due, done };
}

function renderInsights() {
  let best = null;

  for (const r of reminders) {
    if (r.done) continue;
    const t = pendingFireMs(r);
    if (!Number.isFinite(t)) continue;
    if (!best || t < best.t) best = { r, t };
  }

  if (!best) {
    nextUpTitle.textContent = 'Nothing scheduled';
    nextUpTime.textContent = reminders.length
      ? 'Everything is done 🎉'
      : 'Add a reminder to get started';
    nextUpFill.style.width = '0%';
  } else {
    const iso = new Date(best.t).toISOString();
    const overdue = best.t <= Date.now();

    nextUpTitle.textContent = `${getCategoryIcon(best.r.category)} ${best.r.title}`;
    nextUpTime.textContent = overdue
      ? `Overdue · ${timeUntil(iso)}`
      : `${formatDateTime(iso)} · ${timeUntil(iso)}`;

    let pct = 100;
    if (!overdue) {
      const remaining = best.t - Date.now();
      pct = Math.max(0, Math.min(100, (1 - remaining / 86400000) * 100));
    }
    nextUpFill.style.width = `${pct}%`;
  }

  const { due, done } = todayStats();
  const pct = due ? Math.round((done / due) * 100) : 0;

  progressText.textContent = `${done} / ${due} done`;
  progressSub.textContent = due === 0
    ? 'Nothing due today 🌴'
    : done === due
      ? 'All done today! 🎉'
      : pct >= 50
        ? 'Great progress, keep it up 🔥'
        : 'You have got this 💪';
  progressFill.style.width = `${pct}%`;
}

function renderCard(r) {
  const overdue = !r.done && isOverdue(r.time);
  const cardClass = `reminder-card${overdue ? ' overdue' : ''}${r.done ? ' done' : ''}`;
  const repeatLabel = getRepeatLabel(r.repeat);

  return `
    <li class="${cardClass}" data-category="${r.category}" data-id="${r.id}">
      <button class="check-btn ${r.done ? 'checked' : ''}"
              data-action="toggle" data-id="${r.id}"
              aria-label="Mark done">
        ${r.done ? '✓' : ''}
      </button>

      <div class="reminder-body" data-action="edit" data-id="${r.id}">
        <div class="reminder-title">${escapeHtml(r.title)}</div>
        ${r.description ? `<div class="reminder-desc">${escapeHtml(r.description)}</div>` : ''}
        <div class="reminder-meta">
          <span class="meta-tag">
            ${getCategoryIcon(r.category)} ${formatDateTime(r.time)}
          </span>
          ${!r.done
            ? `<span class="meta-tag ${overdue ? 'overdue-tag' : 'time-until'}">${timeUntil(r.time)}</span>`
            : ''}
          ${r.priority !== 'medium'
            ? `<span class="meta-tag priority-${r.priority}">${r.priority}</span>`
            : ''}
          ${repeatLabel
            ? `<span class="meta-tag repeat">🔁 ${repeatLabel}</span>`
            : ''}
        </div>
      </div>

      <div class="card-actions">
        <button class="action-btn delete"
                data-action="delete" data-id="${r.id}"
                aria-label="Delete">🗑</button>
      </div>
    </li>
  `;
}

function getFilteredReminders() {
  let list = [...reminders];

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q)
    );
  }

  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const endOfWeek = new Date(now);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  switch (currentFilter) {
    case 'today':
      list = list.filter(r => {
        const d = new Date(r.time);
        return !r.done && d >= now && d <= endOfToday;
      });
      break;

    case 'week':
      list = list.filter(r => {
        const d = new Date(r.time);
        return !r.done && d >= now && d <= endOfWeek;
      });
      break;

    case 'overdue':
      list = list.filter(r => !r.done && isOverdue(r.time));
      break;

    case 'high':
      list = list.filter(r => !r.done && r.priority === 'high');
      break;
  }

  return list;
}

function openModal(editId = null) {
  editingId = editId;

  if (editId) {
    modalTitle.textContent = 'Edit Reminder';
    saveBtn.textContent = 'Update';

    const r = reminders.find(x => x.id === editId);
    if (!r) return;

    inputTitle.value = r.title;
    inputDesc.value = r.description || '';
    inputDateTime.value = toLocalInput(r.time);
    inputCategory.value = r.category;
    inputPriority.value = r.priority;
    inputRepeat.value = r.repeat || 'none';
  } else {
    modalTitle.textContent = 'New Reminder';
    saveBtn.textContent = 'Save Reminder';

    inputTitle.value = '';
    inputDesc.value = '';
    inputDateTime.value = defaultDateTime();
    inputCategory.value = 'personal';
    inputPriority.value = 'medium';
    inputRepeat.value = 'none';
  }

  modalOverlay.classList.add('active');
  setTimeout(() => inputTitle.focus(), 300);
}

function closeModalFn() {
  modalOverlay.classList.remove('active');
  editingId = null;
}

async function saveReminder() {
  const title = inputTitle.value.trim();
  const desc = inputDesc.value.trim();
  const dt = inputDateTime.value;

  if (!title) {
    showToast('Title required', 'error');
    return;
  }
  if (!dt) {
    showToast('Date & time required', 'error');
    return;
  }

  const time = new Date(dt);
  if (time <= new Date() && !editingId) {
    showToast('Choose a future time', 'error');
    return;
  }

  const data = {
    title,
    description: desc,
    time: time.toISOString(),
    category: inputCategory.value,
    priority: inputPriority.value,
    repeat: inputRepeat.value
  };

  if (editingId) {
    const idx = reminders.findIndex(r => r.id === editingId);
    if (idx === -1) return;

    await cancelNotification(editingId);
    Object.assign(reminders[idx], data);
    reminders[idx].snoozedUntil = null;
    reminders[idx].lastRingKey = null;

    if (!reminders[idx].done) {
      try {
        await scheduleReminder(reminders[idx]);
      } catch (e) {
        console.error('Reschedule failed:', e);
      }
    }

    showToast('Reminder updated', 'success');
  } else {
    const id = NOTIF_ID_START + Math.floor(Math.random() * 900000);

    const newReminder = {
      id,
      ...data,
      done: false,
      createdAt: new Date().toISOString()
    };

    try {
      await scheduleReminder(newReminder);
    } catch (e) {
      console.error('Schedule failed:', e);
      showToast('Could not schedule notification', 'error');
    }

    reminders.push(newReminder);
    showToast('Reminder added', 'success');
  }

  await saveData();
  render();
  closeModalFn();
}

async function toggleDone(id) {
  const r = reminders.find(x => x.id === id);
  if (!r) return;

  r.done = !r.done;

  if (r.done) {
    r.snoozedUntil = null;
    await cancelNotification(id);
    if (alarmState && alarmState.id === id) hideAlarm();
  } else {
    r.lastRingKey = null;
    try {
      await scheduleReminder(r);
    } catch (e) {
      console.error('Reschedule failed:', e);
    }
  }

  await saveData();
  render();
}

function askDelete(id) {
  const r = reminders.find(x => x.id === id);
  if (!r) return;

  pendingDeleteId = id;
  confirmTitle.textContent = 'Delete Reminder?';
  confirmMsg.textContent = `"${r.title}" will be removed permanently.`;
  confirmOverlay.classList.add('active');
}

async function confirmDelete() {
  if (pendingDeleteId == null) return;

  const id = pendingDeleteId;
  const idx = reminders.findIndex(r => r.id === id);
  const removed = idx !== -1 ? reminders[idx] : null;

  await cancelNotification(id);

  reminders = reminders.filter(r => r.id !== id);
  await saveData();
  render();

  confirmOverlay.classList.remove('active');
  pendingDeleteId = null;

  if (removed) {
    lastDeleted = { reminder: removed, index: idx };
    showToast('Reminder deleted', 'info', {
      label: 'Undo',
      onClick: async () => {
        if (!lastDeleted) return;
        reminders.splice(
          Math.min(lastDeleted.index, reminders.length),
          0,
          lastDeleted.reminder
        );
        const restored = lastDeleted.reminder;
        lastDeleted = null;

        if (!restored.done) {
          try { await scheduleReminder(restored); } catch (e) { /* ignore */ }
        }

        await saveData();
        render();
        showToast('Restored ✅', 'success');
      }
    });
  } else {
    showToast('Reminder deleted', 'success');
  }
}

function closeConfirm() {
  confirmOverlay.classList.remove('active');
  pendingDeleteId = null;
}

fabAdd.addEventListener('click', () => openModal(null));
themeToggle.addEventListener('click', toggleTheme);

searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  render();
});

filterChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;

  filterChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');

  currentFilter = chip.dataset.filter;
  render();
});

listEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = parseInt(btn.dataset.id, 10);

  if (action === 'toggle') toggleDone(id);
  else if (action === 'edit') openModal(id);
  else if (action === 'delete') askDelete(id);
});

saveBtn.addEventListener('click', saveReminder);
cancelBtn.addEventListener('click', closeModalFn);
closeModalBtn.addEventListener('click', closeModalFn);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModalFn();
});

confirmYes.addEventListener('click', confirmDelete);
confirmNo.addEventListener('click', closeConfirm);

confirmOverlay.addEventListener('click', (e) => {
  if (e.target === confirmOverlay) closeConfirm();
});

inputTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    inputDesc.focus();
  }
});

async function registerNotificationActionTypes() {
  if (!LocalNotifications || !LocalNotifications.registerActionTypes) return;

  try {
    await LocalNotifications.registerActionTypes({
      types: [{
        id: ACTION_TYPE_ID,
        actions: [
          { id: 'snooze', title: 'Snooze' },
          { id: 'done', title: 'Done' }
        ]
      }]
    });
  } catch (e) {
    console.warn('Register action types failed:', e);
  }
}

function setupNotificationListeners() {
  if (!LocalNotifications) return;

  // User pressed Snooze / Done directly on the notification (even from lock screen)
  LocalNotifications.addListener('localNotificationActionPerformed', async (payload) => {
    const id = payload.notification?.extra?.reminderId;
    const actionId = payload.actionId;
    const r = typeof id === 'number' ? reminders.find(x => x.id === id) : null;

    if (r && actionId === 'snooze' && !r.done) {
      if (alarmState && alarmState.id === r.id) hideAlarm();
      await snoozeReminder(r);
      return;
    }

    if (r && actionId === 'done' && !r.done) {
      if (alarmState && alarmState.id === r.id) hideAlarm();
      await toggleDone(r.id);
      showToast('Marked done from notification 🎉', 'success');
      return;
    }

    // Plain tap: jump to the reminder, and ring it if it is still due
    if (typeof id === 'number') {
      const el = listEl.querySelector(`[data-id="${id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      alarmTick();
    }
  });

  // A notification was just delivered while our process is alive:
  // keep the repeat alerts armed for whatever comes next.
  LocalNotifications.addListener('localNotificationReceived', (payload) => {
    const id = payload.extra?.reminderId;
    const r = typeof id === 'number' ? reminders.find(x => x.id === id) : null;
    if (!r || r.done) return;
    armChains(r);
  });
}

/* ============ ONBOARDING (first-run permission setup) ============ */

const onboardingScreen = $('onboardingScreen');
const obIcon = $('obIcon');
const obTitle = $('obTitle');
const obDesc = $('obDesc');
const obActionBtn = $('obActionBtn');
const obSkipBtn = $('obSkipBtn');
const obDots = document.querySelectorAll('.onboarding-dots .dot');

function buildOnboardingSteps() {
  const platform = Capacitor.getPlatform ? Capacitor.getPlatform() : 'web';
  const steps = [];

  steps.push({
    icon: '🔔',
    title: 'Enable Notifications',
    desc: 'ReminderKrunga needs notification permission so it can remind you on time, every time.',
    btnText: 'Allow Notifications',
    action: async () => {
      if (LocalNotifications) {
        try { await LocalNotifications.requestPermissions(); } catch (e) { /* ignore */ }
      }
    }
  });

  if (platform === 'android') {
    steps.push({
      icon: '⏰',
      title: 'Allow Exact Alarms',
      desc: 'So reminders arrive at the exact minute (not late), please allow "Alarms & reminders" on the next screen.',
      btnText: 'Open Settings',
      action: async () => {
        if (LocalNotifications?.changeExactNotificationSetting) {
          try { await LocalNotifications.changeExactNotificationSetting(); } catch (e) { /* ignore */ }
        }
      }
    });

    steps.push({
      icon: '🔋',
      title: 'One Last Step',
      desc: 'Some phones (Vivo, Xiaomi, Oppo, Realme, OnePlus) restrict background apps. Please turn ON "Autostart" for ReminderKrunga and lock it in Recent Apps, so reminders never fail.',
      btnText: 'Open App Settings',
      action: async () => {
        if (NativeSettings) {
          try {
            await NativeSettings.open({
              optionAndroid: 'application_details',
              optionIOS: 'app'
            });
          } catch (e) { /* ignore */ }
        }
      }
    });
  }

  return steps;
}

function runOnboarding() {
  return new Promise(async (resolve) => {
    const platform = Capacitor.getPlatform ? Capacitor.getPlatform() : 'web';
    if (platform === 'web') { resolve(); return; }

    let alreadyDone = false;
    try {
      if (Preferences) {
        const { value } = await Preferences.get({ key: ONBOARD_KEY });
        alreadyDone = value === 'true';
      } else {
        alreadyDone = localStorage.getItem(ONBOARD_KEY) === 'true';
      }
    } catch (e) { /* ignore */ }

    if (alreadyDone) { resolve(); return; }

    const steps = buildOnboardingSteps();
    let stepIndex = 0;

    function renderStep() {
      const step = steps[stepIndex];
      obIcon.textContent = step.icon;
      obTitle.textContent = step.title;
      obDesc.textContent = step.desc;
      obActionBtn.textContent = step.btnText;
      obDots.forEach((d, i) => d.classList.toggle('active', i === stepIndex));
    }

    async function finish() {
      onboardingScreen.classList.remove('active');
      try {
        if (Preferences) await Preferences.set({ key: ONBOARD_KEY, value: 'true' });
        else localStorage.setItem(ONBOARD_KEY, 'true');
      } catch (e) { /* ignore */ }
      obActionBtn.removeEventListener('click', onAction);
      obSkipBtn.removeEventListener('click', onSkip);
      resolve();
    }

    async function onAction() {
      const step = steps[stepIndex];
      obActionBtn.disabled = true;
      try { await step.action(); } catch (e) { /* ignore */ }
      obActionBtn.disabled = false;

      stepIndex++;
      if (stepIndex >= steps.length) finish();
      else renderStep();
    }

    function onSkip() {
      finish();
    }

    obActionBtn.addEventListener('click', onAction);
    obSkipBtn.addEventListener('click', onSkip);

    renderStep();
    onboardingScreen.classList.add('active');
  });
}

/* ============ SETTINGS ============ */

function openSettings() {
  setAlarmSound.checked = !!settings.alarmSound;
  setVibration.checked = !!settings.vibration;
  setChainAlerts.checked = !!settings.chainAlerts;
  setRingMinutes.value = String(settings.ringMinutes);
  setSnoozeMinutes.value = String(settings.snoozeMinutes);
  settingsOverlay.classList.add('active');
}

function closeSettingsFn() {
  settingsOverlay.classList.remove('active');
}

async function rescheduleAll(skipId = null) {
  for (const r of reminders) {
    if (r.done) continue;
    if (skipId != null && r.id === skipId) continue;
    try { await scheduleReminder(r); } catch (e) { /* ignore */ }
  }
}

/**
 * While the full screen alarm is up, the WebView owns the ringing.
 * The moment the app is sent to the background we hand that job back to the
 * native repeat alerts, so the phone keeps nagging even if Android pauses us.
 */
async function handOverRingToNative() {
  if (!alarmState) return;
  const r = getReminder(alarmState.id);
  if (r) {
    try { await armChains(r); } catch (e) { /* ignore */ }
  }
}

/** Back in the foreground: the overlay takes over again, drop the nudges. */
async function takeRingBackFromNative() {
  if (!alarmState) return;
  const r = getReminder(alarmState.id);
  if (!r) return;

  const stale = [];
  for (let slot = 1; slot <= MAX_CHAIN_SLOTS; slot++) stale.push({ id: chainIdFor(r.id, slot) });

  if (LocalNotifications) {
    try { await LocalNotifications.cancel({ notifications: stale }); } catch (e) { /* ignore */ }
  }
}

async function onSettingChange() {
  const prevRing = settings.ringMinutes;
  const prevChain = settings.chainAlerts;

  settings.alarmSound = setAlarmSound.checked;
  settings.vibration = setVibration.checked;
  settings.chainAlerts = setChainAlerts.checked;
  settings.ringMinutes = parseInt(setRingMinutes.value, 10) || 5;
  settings.snoozeMinutes = parseInt(setSnoozeMinutes.value, 10) || 5;

  await saveSettings();

  if (settings.ringMinutes !== prevRing || settings.chainAlerts !== prevChain) {
    try { await rescheduleAll(); } catch (e) { /* ignore */ }
    showToast('Alarm timing updated', 'success');
  }

  render();
}

settingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettingsFn);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettingsFn();
});

[setAlarmSound, setVibration, setChainAlerts, setRingMinutes, setSnoozeMinutes]
  .forEach(el => el.addEventListener('change', onSettingChange));

testSoundBtn.addEventListener('click', async () => {
  try {
    alarmAudio.loop = false;
    alarmAudio.currentTime = 0;
    await alarmAudio.play();
    setTimeout(() => {
      if (!alarmState) {
        alarmAudio.pause();
        alarmAudio.currentTime = 0;
      }
    }, 3000);
    showToast('Playing… check your volume', 'info');
  } catch (e) {
    showToast('Could not play the sound', 'error');
  }
});

/* ============ BACKUP / RESTORE ============ */

let backupMode = 'export';

function backupPayload() {
  return JSON.stringify({
    app: 'ReminderKrunga',
    version: 1,
    exportedAt: new Date().toISOString(),
    reminders,
    settings
  }, null, 2);
}

function openBackup(mode) {
  backupMode = mode;
  backupOverlay.classList.add('active');

  if (mode === 'export') {
    backupTitle.textContent = '📤 Export backup';
    backupHint.textContent = 'Copy this text and keep it somewhere safe (Notes, Drive, WhatsApp).';
    backupText.value = backupPayload();
    backupPrimary.textContent = 'Copy';
    backupSecondary.textContent = 'Share / Save';
  } else {
    backupTitle.textContent = '📥 Import backup';
    backupHint.textContent = 'Paste your backup text below, or pick a backup file.';
    backupText.value = '';
    backupPrimary.textContent = 'Import';
    backupSecondary.textContent = 'Choose file';
  }
}

function closeBackupFn() {
  backupOverlay.classList.remove('active');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
    return;
  } catch (e) { /* clipboard blocked */ }

  backupText.focus();
  backupText.select();
  try {
    document.execCommand('copy');
    showToast('Copied to clipboard', 'success');
  } catch (e) {
    showToast('Select the text and copy it manually', 'error');
  }
}

async function shareBackup() {
  const data = backupText.value;

  if (navigator.share) {
    try {
      await navigator.share({ title: 'ReminderKrunga backup', text: data });
      return;
    } catch (e) {
      return; // user closed the share sheet
    }
  }

  try {
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reminderkrunga-backup-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('Backup file saved', 'success');
  } catch (e) {
    showToast('Copy the text instead', 'error');
  }
}

async function importBackup(raw) {
  if (!raw || !raw.trim()) {
    showToast('Paste or choose a backup first', 'error');
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    showToast('That does not look like a backup', 'error');
    return false;
  }

  const incoming = Array.isArray(parsed) ? parsed : parsed.reminders;
  if (!Array.isArray(incoming)) {
    showToast('No reminders found in that backup', 'error');
    return false;
  }

  let added = 0;
  for (const item of incoming) {
    if (!item || typeof item.id !== 'number' || !item.title || !item.time) continue;
    if (reminders.some(r => r.id === item.id)) continue;
    reminders.push(item);
    added++;
  }

  if (parsed.settings && typeof parsed.settings === 'object') {
    settings = { ...DEFAULT_SETTINGS, ...settings, ...parsed.settings };
    await saveSettings();
    applyTheme();
  }

  await saveData();
  try { await rescheduleAll(); } catch (e) { /* ignore */ }
  render();

  showToast(
    added ? `Restored ${added} reminder${added === 1 ? '' : 's'} ✅` : 'Nothing new to restore',
    added ? 'success' : 'info'
  );
  return added > 0;
}

exportBtn.addEventListener('click', () => openBackup('export'));
importBtn.addEventListener('click', () => openBackup('import'));
closeBackupBtn.addEventListener('click', closeBackupFn);
backupOverlay.addEventListener('click', (e) => {
  if (e.target === backupOverlay) closeBackupFn();
});

backupPrimary.addEventListener('click', async () => {
  if (backupMode === 'export') {
    await copyText(backupText.value);
  } else {
    const ok = await importBackup(backupText.value);
    if (ok) closeBackupFn();
  }
});

backupSecondary.addEventListener('click', () => {
  if (backupMode === 'export') {
    shareBackup();
  } else {
    backupFile.click();
  }
});

backupFile.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  try {
    backupText.value = await file.text();
    showToast('File loaded — tap Import', 'info');
  } catch (err) {
    showToast('Could not read that file', 'error');
  }
});

/* ============ APP INIT ============ */

(async function init() {
  const loaderScreen = $('loaderScreen');
  const startTime = Date.now();
  const MIN_LOADER_MS = 1300;

  await setupNotificationChannel();
  await registerNotificationActionTypes();
  await loadData();
  setupNotificationListeners();

  const elapsed = Date.now() - startTime;
  if (elapsed < MIN_LOADER_MS) {
    await new Promise(r => setTimeout(r, MIN_LOADER_MS - elapsed));
  }
  loaderScreen.classList.add('hide');

  await runOnboarding();

  // Catch anything that came due while the app was closed / starting up,
  // then heal any native schedule that got lost (e.g. app killed mid-alarm).
  alarmTick();
  if (!alarmState) {
    try { await rescheduleAll(); } catch (e) { /* ignore */ }
  }

  // The alarm checks every second so it rings on the exact minute
  setInterval(alarmTick, 1000);

  // Keep the countdowns / progress fresh
  setInterval(() => {
    render();
  }, 60000);

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      render();
      alarmTick();

      // Screen lock releases the wake lock on its own — grab it back
      if (alarmState) {
        requestWakeLock();
        await takeRingBackFromNative();
      }
    } else if (alarmState) {
      // Android may pause our timers — let the native alerts keep ringing
      await handOverRingToNative();
    }
  });
})();

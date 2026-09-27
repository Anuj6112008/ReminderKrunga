# ReminderKrunga 🔔

A dead-simple, **reliable** reminder app for Android that actually makes sure you don't forget —
because when the time comes, it **rings like an alarm clock until you deal with it**.

Built with Capacitor (HTML/CSS/JS) and packaged as an APK automatically by GitHub Actions.

---

## ✨ What it does

### ⏰ Alarm mode (the main thing)
When a reminder comes due, the app goes **full screen and keeps ringing**:

- 🔊 Loops the alarm tone until *you* stop it
- 📳 Vibrates in sync with the ring
- 🔋 Keeps the screen awake while it rings
- ⏳ Auto-silences after your configured time (1/3/5/10 min) so it never drains the battery forever

**Three ways to make it stop:**

| Button | What it does |
|---|---|
| **Snooze** | Silence now, ring again after your snooze duration (3–30 min) |
| **Stop** | Silence it — the reminder stays in your list as pending/overdue |
| **Mark as Done** | Silences it and ticks the reminder off ✅ |

### 🔁 It keeps nagging (even if the app is closed)
Android pauses any app that sits in the background, so a web page alone can't ring forever.
ReminderKrunga works around that with a **repeat-alert chain**: besides the normal notification it
books a handful of follow-up alerts (every ~45 seconds for the full ring duration), each with
**Snooze** and **Done** buttons right on the notification — so you can answer from the lock screen.

- App open → the full screen alarm owns the ringing, the chain stays silent
- App backgrounded → the ring is handed back to the native alerts automatically
- App closed → the scheduled notifications (main + chain) keep firing

### Everything else
- 🕐 One-off and repeating reminders (daily / weekly / monthly)
- 🏷️ Categories (work, personal, health, study), priority levels, notes
- 🔍 Search + filters (Today, This Week, Overdue, High priority)
- ⏭️ **Next up** card with a live countdown to whatever is coming next
- 🔥 **Today** progress bar so you can see the day getting cleared
- 🔔 Notification action buttons: **Snooze** / **Done** without opening the app
- ↩️ **Undo delete** — a 5 second window to take a delete back
- 💾 **Backup / Restore** — export everything as text or a file, import it on a new phone
- 🌙 Dark mode, light mode
- 🔐 100% local storage. No account, no internet, no tracking.

---

## 🛠️ Build the APK

Push to `main` (or run the workflow manually) and GitHub Actions builds it:

```bash
git add .
git commit -m "feat: alarm mode"
git push origin main
```

The **Build Android APK** workflow uploads `ReminderKrunga-debug-apk` as an artifact (kept 30 days).

Locally:

```bash
npm install
npx cap add android
npm run build:android
```

## 📁 Project layout

```
www/            the entire app (index.html, app.js, style.css, reminder_tone.wav)
assets/         icons, splash screen and the alarm tone used by native notifications
.github/        CI workflow that assembles the APK
```

## ⚙️ How the alarm is scheduled

Each reminder can own up to 11 native notifications — all in non-overlapping ID ranges so they can
never collide:

| Kind | ID formula | Purpose |
|---|---|---|
| Main | `reminder.id` | the actual reminder (repeats natively for daily/weekly/monthly) |
| Snooze | `95000000 + id` | the "ring again" alert after you press Snooze |
| Chain | `1000000 + id * 100 + slot` | the repeat alerts while a reminder is unanswered |

## 🔍 Alarm diagnostics

The app has a collapsible **Alarm diagnostics** card right under the header. It prints a one-line
verdict — what specifically is broken — plus permissions, what Android is still holding, and the
last events from both sides of the bridge:

| Event | Meaning |
|---|---|
| `arm … via=setAlarmClock` | the alarm was booked (exact) |
| `fire … ageMs=…` | Android actually delivered it |
| `fire … SKIPPED stale` | it was delivered too late to ring |
| `fire … UNKNOWN` | it fired but no longer had a reminder attached |
| `fgs … REFUSED` | Android blocked the ringing service, so `AlarmRingFallback` took over |
| `snooze … re-armed in 5m` | Snooze was pressed (alarm screen or notification) and re-booked |
| `stop` / `done` | the ring was silenced / completed from the alarm screen or notification |
| `js … already stopped on Android` | the lock-screen Stop was honoured: the app asks instead of ringing again |
| `heal … missing` | a schedule Android had lost was re-booked on app open |

Events are durable (they survive the process being killed) and kept one slot per type and alarm,
so opening the app repeatedly never washes the evidence out. **Copy log** puts the whole thing on
the clipboard — that is what to send when reporting that an alarm did not ring.

A **Stop pressed while the app was closed** is remembered by Android too. Opening the app
afterwards does not start ringing again — it raises a popup with **Snooze / Mark done / Later**
instead, because ringing again would throw away what the user just did.

## ⚠️ One Capacitor pitfall that disables every alarm

`PluginCall.getDouble()` only accepts `Double`, `Float` and `Integer` — but org.json parses an
epoch-millisecond timestamp like `1790510520000` as a **`Long`**, so it came back `null` and the
plugin rejected every schedule. `getInt("id")` kept working (a small id really is an `Integer`),
which made the bug look like a partial failure. Read wide numbers through
`AlarmClockPlugin.readNumber()` instead, and never through the typed getters.

The diagnostics card is there to catch exactly this class of silent bridge failure: its verdict
names a rejected schedule, and Android echoes the booked time back so a value that does not
survive the trip is flagged rather than quietly lost.

## 📱 Tips for your users

For reminders that must never be missed, ask users to allow **Exact alarms** and turn on
**Autostart** (Xiaomi/Vivo/Oppo/Realme/OnePlus) — the first-run onboarding walks them through it.

---

Made with ❤ by **@PyAnuj**

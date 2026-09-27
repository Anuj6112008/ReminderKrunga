package com.reminderkrunga.app.alarm;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

/**
 * Single entry point for everything the system can send us:
 * the AlarmManager FIRE, the notification action buttons and the
 * buttons on the full screen AlarmActivity.
 */
public class AlarmReceiver extends BroadcastReceiver {

    private static final String TAG = "AlarmReceiver";

    public static final String PKG = "com.reminderkrunga.app.alarm.";
    public static final String ACTION_FIRE = PKG + "FIRE";
    public static final String ACTION_STOP = PKG + "STOP";
    public static final String ACTION_SNOOZE = PKG + "SNOOZE";
    public static final String ACTION_DONE = PKG + "DONE";

    public static final String EXTRA_ID = "alarmId";

    /** Longer than this and the phone was off/asleep past the alarm. */
    private static final long MISSED_GRACE_MS = 61 * 60 * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        int id = intent.getIntExtra(EXTRA_ID, -1);
        if (id < 0) return;

        AlarmStore store = AlarmStore.getInstance(context);

        if (ACTION_FIRE.equals(action)) {
            fire(context, store, id);
        } else if (ACTION_STOP.equals(action)) {
            dismiss(context, store, id, false);
        } else if (ACTION_DONE.equals(action)) {
            dismiss(context, store, id, true);
        } else if (ACTION_SNOOZE.equals(action)) {
            snooze(context, store, id);
        }
    }

    private void fire(Context context, AlarmStore store, int id) {
        String key = String.valueOf(id);
        JSONObject raw = store.get(AlarmStoreSection.PENDING, key);
        if (raw == null) raw = store.get(AlarmStoreSection.RINGING, key);
        if (raw == null) {
            Log.w(TAG, "FIRE for unknown alarm " + id);
            return;
        }

        AlarmStore.AlarmInfo info = AlarmStore.AlarmInfo.fromJson(raw);
        if (info == null) return;

        long now = System.currentTimeMillis();

        // Re-arm repeating alarms before anything else so a crash mid-ring
        // still leaves the next occurrence booked.
        if (info.base > 0 && !"none".equals(info.repeat)) {
            long next = AlarmScheduler.nextOccurrence(info.base, info.repeat, now);
            if (next > 0) {
                AlarmStore.AlarmInfo followUp = AlarmStore.AlarmInfo.fromJson(raw);
                followUp.at = next;
                followUp.firedAt = 0;
                followUp.until = 0;
                store.put(AlarmStoreSection.PENDING, key, followUp.toJson());
                AlarmScheduler.schedule(context, followUp);
            } else {
                store.remove(AlarmStoreSection.PENDING, key);
            }
        } else {
            store.remove(AlarmStoreSection.PENDING, key);
        }

        store.remove(AlarmStoreSection.SNOOZE, key);

        // Phone was switched off past this one: do not blast the alarm now.
        if (now - info.at > MISSED_GRACE_MS) {
            Log.i(TAG, "Skipping stale alarm " + id);
            return;
        }

        info.firedAt = now;
        info.until = now + info.ringMinutes * 60000L;
        store.put(AlarmStoreSection.RINGING, key, info.toJson());

        // Notification first: it carries the full screen intent and is the
        // only path left if Android refuses the foreground service start.
        AlarmService.postNotification(context, info);

        try {
            Intent service = new Intent(context, AlarmService.class);
            service.putExtra(AlarmService.EXTRA_ID, info.id);
            service.putExtra(AlarmService.EXTRA_INFO, info.toJson().toString());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception e) {
            // Android 12+ can refuse background FGS starts. The full screen
            // intent will launch AlarmActivity, which starts the service again
            // from the foreground where it is always allowed.
            Log.w(TAG, "Foreground service start refused: " + e.getMessage());
        }
    }

    private void dismiss(Context context, AlarmStore store, int id, boolean done) {
        String key = String.valueOf(id);

        store.remove(AlarmStoreSection.RINGING, key);
        store.remove(AlarmStoreSection.SNOOZE, key);
        if (done) {
            try {
                store.put(AlarmStoreSection.PENDING_DONE, key, new JSONObject().put("done", true));
            } catch (Exception ignored) {
            }
        }

        // A future occurrence for a repeating alarm stays armed untouched.
        AlarmService.stopRinging(context, id);
    }

    private void snooze(Context context, AlarmStore store, int id) {
        String key = String.valueOf(id);

        // Prefer the alarm that is actually sounding, else the next pending one.
        JSONObject raw = store.get(AlarmStoreSection.RINGING, key);
        if (raw == null) raw = store.get(AlarmStoreSection.PENDING, key);

        AlarmService.stopRinging(context, id);
        store.remove(AlarmStoreSection.RINGING, key);

        if (raw == null) return;

        AlarmStore.AlarmInfo info = AlarmStore.AlarmInfo.fromJson(raw);
        if (info == null) return;

        long at = System.currentTimeMillis() + info.snoozeMinutes * 60000L;
        info.at = at;
        info.firedAt = 0;
        info.until = 0;

        store.put(AlarmStoreSection.PENDING, key, info.toJson());
        try {
            JSONObject snooze = new JSONObject();
            snooze.put("at", at);
            snooze.put("info", info.toJson());
            store.put(AlarmStoreSection.SNOOZE, key, snooze);
        } catch (Exception ignored) {
        }

        AlarmScheduler.schedule(context, info);
    }

    /** Section names kept in one place so the strings never drift. */
    public static final class AlarmStoreSection {
        public static final String PENDING = "pending";
        public static final String RINGING = "ringing";
        public static final String SNOOZE = "snooze";
        public static final String PENDING_DONE = "pendingDone";

        private AlarmStoreSection() {
        }
    }

    /** Cancels any posted notification for this alarm. */
    static void cancelNotification(Context context, int id) {
        try {
            NotificationManager nm = (NotificationManager)
                    context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(AlarmService.notificationId(id));
        } catch (Exception ignored) {
        }
    }
}

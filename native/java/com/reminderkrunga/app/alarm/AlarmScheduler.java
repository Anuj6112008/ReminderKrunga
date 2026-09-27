package com.reminderkrunga.app.alarm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.reminderkrunga.app.MainActivity;

import java.util.Calendar;

/**
 * Arms a single alarm.
 *
 * Order of attempts, newest behaviour first:
 *   1. setAlarmClock          -> the real alarm-clock API, Doze exempt
 *   2. setExactAndAllowWhileIdle -> exact, survives Doze
 *   3. setAndAllowWhileIdle   -> inexact last resort (may drift a few minutes)
 *
 * Steps 1 and 2 throw SecurityException when Android 12+ exact alarm access is
 * revoked, which is why every attempt is guarded.
 */
public final class AlarmScheduler {

    private static final String TAG = "AlarmScheduler";
    private static final int SHOW_REQUEST_BASE = 900000;

    private AlarmScheduler() {
    }

    private static PendingIntent fireIntent(Context context, int id) {
        Intent intent = new Intent(context, AlarmReceiver.class);
        intent.setAction(AlarmReceiver.ACTION_FIRE);
        intent.putExtra(AlarmReceiver.EXTRA_ID, id);
        return PendingIntent.getBroadcast(context, id, intent, pendingFlags());
    }

    private static int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }

    public static boolean canScheduleExact(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    /** Returns true when the alarm was booked exactly. */
    public static boolean schedule(Context context, AlarmStore.AlarmInfo info) {
        if (info == null || info.id < 0 || info.at <= 0) return false;

        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return false;

        long at = Math.max(info.at, System.currentTimeMillis());
        PendingIntent operation = fireIntent(context, info.id);

        // 1. Alarm clock API
        try {
            Intent show = new Intent(context, MainActivity.class);
            show.putExtra(AlarmReceiver.EXTRA_ID, info.id);
            PendingIntent showIntent = PendingIntent.getActivity(
                    context, SHOW_REQUEST_BASE + info.id, show, pendingFlags());
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, showIntent), operation);
            Log.d(TAG, "setAlarmClock id=" + info.id);
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "setAlarmClock denied, falling back: " + e.getMessage());
        } catch (Exception e) {
            Log.w(TAG, "setAlarmClock failed: " + e.getMessage());
        }

        // 2. Exact, allow while idle
        if (canScheduleExact(context)) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, at, operation);
                }
                Log.d(TAG, "setExactAndAllowWhileIdle id=" + info.id);
                return true;
            } catch (SecurityException e) {
                Log.w(TAG, "exact alarm denied, falling back: " + e.getMessage());
            } catch (Exception e) {
                Log.w(TAG, "exact alarm failed: " + e.getMessage());
            }
        }

        // 3. Inexact but still wakes the device
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, at, operation);
            }
            Log.w(TAG, "inexact fallback id=" + info.id);
            return false;
        } catch (Exception e) {
            Log.e(TAG, "could not schedule alarm " + info.id + ": " + e.getMessage());
            return false;
        }
    }

    public static void cancel(Context context, int id) {
        if (id < 0) return;
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = fireIntent(context, id);
        am.cancel(pi);
        pi.cancel();
    }

    /** First occurrence of {@code repeat} strictly after {@code after}, from base. */
    public static long nextOccurrence(long base, String repeat, long after) {
        if (base <= 0 || repeat == null || "none".equals(repeat)) return -1L;

        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(base);

        long t = base;
        int guard = 0;
        while (t <= after && guard++ < 2000) {
            if ("daily".equals(repeat)) {
                c.add(Calendar.DAY_OF_MONTH, 1);
            } else if ("weekly".equals(repeat)) {
                c.add(Calendar.DAY_OF_MONTH, 7);
            } else if ("monthly".equals(repeat)) {
                c.add(Calendar.MONTH, 1);
            } else {
                return -1L;
            }
            t = c.getTimeInMillis();
        }
        return t > after ? t : -1L;
    }
}

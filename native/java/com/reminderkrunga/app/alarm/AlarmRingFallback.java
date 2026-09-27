package com.reminderkrunga.app.alarm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

/**
 * Rings without a foreground service.
 *
 * Android 12+ can refuse to start a foreground service while the app is in
 * the background, and on such a device the alarm would otherwise come up
 * completely silent - which is exactly what was being reported.
 *
 * A BroadcastReceiver is still allowed to hold a wakelock and to play audio;
 * neither is a background restriction. So when the service start is refused
 * this becomes the safety net: it loops the alarm tone in the process and
 * arms its own STOP alarm for the end of the ring window, so nothing is left
 * running forever if the process is killed later.
 */
public final class AlarmRingFallback {

    private static final String TAG = "AlarmRingFallback";
    private static final long WAKE_LOCK_MS = 12 * 60 * 1000L;
    private static final int STOP_REQUEST_BASE = 700000;

    private static MediaPlayer player;
    private static PowerManager.WakeLock wakeLock;
    private static Vibrator vibrator;
    private static int ringingId = -1;

    private AlarmRingFallback() {
    }

    public static synchronized boolean isRinging() {
        return player != null || vibrator != null;
    }

    public static synchronized void start(Context context, AlarmStore.AlarmInfo info) {
        if (info == null) return;
        if (ringingId == info.id && isRinging()) return;   // already sounding

        stop();                                            // only one alarm at a time
        ringingId = info.id;

        Context app = context.getApplicationContext();

        acquireWakeLock(app);

        if (info.sound) {
            try {
                int res = app.getResources()
                        .getIdentifier("reminder_tone", "raw", app.getPackageName());
                if (res != 0) {
                    player = MediaPlayer.create(app, res);
                }
                if (player != null) {
                    player.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
                    player.setLooping(true);
                    player.start();
                } else {
                    Log.w(TAG, "no fallback tone available");
                }
            } catch (Exception e) {
                Log.w(TAG, "fallback tone failed: " + e.getMessage());
                player = null;
            }
        }

        if (info.vibrate) {
            vibrate(app);
        }

        armAutoStop(app, info);
        AlarmStore.getInstance(app).log("fallback", "ringing id=" + info.id
                + " sound=" + info.sound + " vibrate=" + info.vibrate);
    }

    public static synchronized void stop() {
        try {
            if (player != null) {
                if (player.isPlaying()) player.stop();
                player.release();
            }
        } catch (Exception ignored) {
        }
        player = null;

        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Exception ignored) {
        }
        vibrator = null;

        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
        wakeLock = null;

        ringingId = -1;
    }

    private static void acquireWakeLock(Context app) {
        try {
            PowerManager pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ReminderKrunga:fallback");
            wakeLock.setReferenceCounted(false);
            if (!wakeLock.isHeld()) wakeLock.acquire(WAKE_LOCK_MS);
        } catch (Exception e) {
            Log.w(TAG, "wake lock failed: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private static void vibrate(Context app) {
        try {
            vibrator = (Vibrator) app.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) {
                vibrator = null;
                return;
            }
            long[] pattern = {0, 700, 500, 700, 500};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrator.vibrate(pattern, 0);
            }
        } catch (Exception e) {
            Log.w(TAG, "vibrate failed: " + e.getMessage());
            vibrator = null;
        }
    }

    /**
     * Books the STOP that ends the ring window. Going through AlarmManager
     * means the silence still happens even if this process dies first.
     */
    private static void armAutoStop(Context app, AlarmStore.AlarmInfo info) {
        try {
            long at = info.until > 0 ? info.until
                    : System.currentTimeMillis() + info.ringMinutes * 60000L;
            if (at <= System.currentTimeMillis()) return;

            Intent intent = new Intent(app, AlarmReceiver.class);
            intent.setAction(AlarmReceiver.ACTION_STOP);
            intent.putExtra(AlarmReceiver.EXTRA_ID, info.id);
            PendingIntent pi = PendingIntent.getBroadcast(app,
                    STOP_REQUEST_BASE + info.id, intent, pendingFlags());

            AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "auto stop could not be armed: " + e.getMessage());
        }
    }

    private static int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }
}

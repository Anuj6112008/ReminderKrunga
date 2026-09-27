package com.reminderkrunga.app.alarm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.IOException;

/**
 * The thing that actually rings while the phone is locked.
 *
 * A foreground service is the only Android construct allowed to keep playing
 * audio when the app is backgrounded and the screen is off. It holds a
 * partial wake lock so the CPU cannot sleep through the tone, and posts the
 * full screen intent notification that turns the screen on over the lock
 * screen via AlarmActivity.
 */
public class AlarmService extends Service {

    private static final String TAG = "AlarmService";
    private static final String CHANNEL_ID = "alarm_channel";

    public static final String EXTRA_ID = "alarmId";
    public static final String EXTRA_INFO = "alarmInfo";

    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private Handler handler;
    private Runnable autoStop;
    private int ringingId = -1;

    public static int notificationId(int id) {
        return 991000 + Math.floorMod(id, 900);
    }

    /**
     * Whether the service is currently sounding an alarm. AlarmActivity polls
     * this: if Android refused the background start and the full screen intent
     * never came up either, the activity rings on its own instead of sitting
     * there silent.
     */
    private static volatile boolean ringingNow = false;

    public static boolean isRinging() {
        return ringingNow;
    }

    /* ---------------------------------------------------------- commands */

    /** Ring this alarm now (also used by AlarmActivity if the start was refused). */
    public static void startRing(Context context, AlarmStore.AlarmInfo info) {
        if (info == null) return;
        Intent intent = new Intent(context, AlarmService.class);
        intent.putExtra(EXTRA_ID, info.id);
        intent.putExtra(EXTRA_INFO, info.toJson().toString());
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception e) {
            Log.w(TAG, "startRing refused: " + e.getMessage());
            // Android 12+ refuses background FGS starts unless an exemption
            // applies. An exact alarm fires one again in a moment, which is
            // an exemption in its own right - so try once more shortly.
            AlarmScheduler.scheduleStartRetry(context, info.id);
        }
    }

    /** Stop ringing and clear the notification. Safe when nothing is running. */
    public static void stopRinging(Context context, int id) {
        try {
            context.stopService(new Intent(context.getApplicationContext(), AlarmService.class));
        } catch (Exception e) {
            Log.w(TAG, "stopService failed: " + e.getMessage());
        }
        if (id >= 0) AlarmReceiver.cancelNotification(context, id);
    }

    /* ------------------------------------------------- notification build */

    public static void postNotification(Context context, AlarmStore.AlarmInfo info) {
        try {
            NotificationManager nm = (NotificationManager)
                    context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureChannel(context, nm);
            nm.notify(notificationId(info.id), buildAlert(context, info));
        } catch (Exception e) {
            Log.w(TAG, "postNotification failed: " + e.getMessage());
        }
    }

    /** One builder for both the posted and the foreground notification. */
    private static Notification buildAlert(Context context, AlarmStore.AlarmInfo info) {
        Intent full = new Intent(context, AlarmActivity.class);
        full.putExtra(AlarmReceiver.EXTRA_ID, info.id);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent fullScreen = PendingIntent.getActivity(
                context, 300000 + info.id, full, pendingFlags());

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(smallIcon(context))
                .setContentTitle(info.title == null || info.title.isEmpty()
                        ? "⏰ Reminder" : info.title)
                .setContentText(info.body == null || info.body.isEmpty()
                        ? "Time for your reminder" : info.body)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fullScreen, true)
                .setContentIntent(fullScreen)
                .addAction(action(context, AlarmReceiver.ACTION_STOP, info.id,
                        400000, "Stop", android.R.drawable.ic_lock_power_off))
                .addAction(action(context, AlarmReceiver.ACTION_SNOOZE, info.id,
                        500000, "Snooze", android.R.drawable.ic_menu_recent_history))
                .addAction(action(context, AlarmReceiver.ACTION_DONE, info.id,
                        600000, "Done", android.R.drawable.checkbox_on_background));

        if (info.until > 0) {
            b.setWhen(info.firedAt > 0 ? info.firedAt : System.currentTimeMillis())
                    .setShowWhen(true);
        }
        return b.build();
    }

    private static NotificationCompat.Action action(Context ctx, String action, int id,
                                                    int requestCode, String label, int icon) {
        Intent i = new Intent(ctx, AlarmReceiver.class);
        i.setAction(action);
        i.putExtra(AlarmReceiver.EXTRA_ID, id);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, requestCode + id, i, pendingFlags());
        return new NotificationCompat.Action.Builder(
                icon, label, pi).build();
    }

    private static int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }

    private static int smallIcon(Context context) {
        int res = context.getResources()
                .getIdentifier("ic_stat_icon", "drawable", context.getPackageName());
        return res != 0 ? res : android.R.drawable.ic_lock_idle_alarm;
    }

    private static void ensureChannel(Context context, NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
        if (existing != null) return;

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Alarms", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Full screen reminder alarms");
        channel.setSound(null, null);          // the service plays the tone itself
        channel.enableVibration(false);        // so does the vibrator
        channel.setBypassDnd(true);
        nm.createNotificationChannel(channel);
    }

    /* ------------------------------------------------------- service life */

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        int id = intent.getIntExtra(EXTRA_ID, -1);
        AlarmStore.AlarmInfo info = null;
        try {
            String raw = intent.getStringExtra(EXTRA_INFO);
            if (raw != null) info = AlarmStore.AlarmInfo.fromJson(new JSONObject(raw));
        } catch (Exception e) {
            Log.w(TAG, "bad alarm payload: " + e.getMessage());
        }
        if (info == null || id < 0) {
            stopSelf();
            return START_NOT_STICKY;
        }

        // startForeground must run within 5s of a foreground service start.
        postNotification(this, info);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(notificationId(id), buildNotification(info),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(notificationId(id), buildNotification(info));
        }

        if (ringingId == id && player != null && player.isPlaying()) {
            return START_NOT_STICKY;   // already sounding, ignore the repeat
        }

        if (ringingId >= 0 && ringingId != id) {
            stopTone();
        }
        ringingId = id;
        startTone(info);
        scheduleAutoStop(info);
        ringingNow = true;
        return START_NOT_STICKY;
    }

    private Notification buildNotification(AlarmStore.AlarmInfo info) {
        NotificationManager nm = (NotificationManager)
                getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) ensureChannel(this, nm);
        return buildAlert(this, info);
    }

    /* ----------------------------------------------------------- ringing */

    private void startTone(AlarmStore.AlarmInfo info) {
        acquireWakeLock();

        if (info.sound) {
            int res = getResources()
                    .getIdentifier("reminder_tone", "raw", getPackageName());
            try {
                if (res != 0) {
                    player = MediaPlayer.create(this, res);
                }
                if (player == null) {
                    Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
                    if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                    if (uri != null) {
                        player = new MediaPlayer();
                        player.setDataSource(this, uri);
                        player.prepare();
                    }
                }
                if (player != null) {
                    player.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
                    player.setLooping(true);
                    player.setOnCompletionListener(mp -> {
                        // Loops forever, but if the stream is cut we retry.
                        try { if (mp.isPlaying()) return; mp.start(); } catch (Exception ignored) { }
                    });
                    requestFocus();
                    player.start();
                } else {
                    Log.w(TAG, "no playable alarm sound");
                }
            } catch (Exception e) {
                Log.w(TAG, "tone failed: " + e.getMessage());
                player = null;
            }
        }

        if (info.vibrate) {
            vibrate();
        }
    }

    @SuppressWarnings("deprecation")
    private void vibrate() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager)
                        getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                vibrator = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator == null || !vibrator.hasVibrator()) return;

            long[] timings = {0, 700, 400, 700, 400, 700, 400};
            int[] amps = {0, 255, 0, 255, 0, 255, 0};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(timings, amps, 0));
            } else {
                // VibrationEffect is API 26+, minSdk here is 22.
                long[] legacy = new long[timings.length];
                System.arraycopy(timings, 0, legacy, 0, timings.length);
                vibrator.vibrate(legacy, -1);
            }
        } catch (Exception e) {
            Log.w(TAG, "vibrate failed: " + e.getMessage());
        }
    }

    private void requestFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ALARM)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                .build())
                        .setWillPauseWhenDucked(false)
                        .build();
                audioManager.requestAudioFocus(focusRequest);
            } else {
                //noinspection deprecation
                audioManager.requestAudioFocus(null, AudioManager.STREAM_ALARM,
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            }
        } catch (Exception e) {
            Log.w(TAG, "audio focus failed: " + e.getMessage());
        }
    }

    private void abandonFocus() {
        try {
            if (audioManager == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
                audioManager.abandonAudioFocusRequest(focusRequest);
            } else {
                //noinspection deprecation
                audioManager.abandonAudioFocus(null);
            }
        } catch (Exception ignored) {
        }
        focusRequest = null;
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                        "ReminderKrunga:alarm");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire(10 * 60 * 1000L);
        } catch (Exception e) {
            Log.w(TAG, "wake lock failed: " + e.getMessage());
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
        wakeLock = null;
    }

    private void scheduleAutoStop(AlarmStore.AlarmInfo info) {
        if (autoStop != null) handler.removeCallbacks(autoStop);
        final int id = info.id;
        long delay = Math.max(1000L, info.until - System.currentTimeMillis());
        autoStop = () -> {
            Log.i(TAG, "auto stop alarm " + id);
            AlarmStore store = AlarmStore.getInstance(getApplicationContext());
            store.remove(AlarmReceiver.AlarmStoreSection.RINGING, String.valueOf(id));
            stopRinging(getApplicationContext(), id);
        };
        handler.postDelayed(autoStop, delay);
    }

    private void stopTone() {
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

        abandonFocus();
        releaseWakeLock();
    }

    @Override
    public void onDestroy() {
        if (autoStop != null) handler.removeCallbacks(autoStop);
        autoStop = null;
        stopTone();
        ringingNow = false;
        if (ringingId >= 0) AlarmReceiver.cancelNotification(this, ringingId);
        ringingId = -1;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

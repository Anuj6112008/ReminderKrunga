package com.reminderkrunga.app.alarm;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * The full screen alarm screen. Shows over the lock screen, turns the screen
 * on and stays up until the user picks one of the three buttons.
 *
 * It never rings itself - AlarmService owns the audio - so this activity is
 * purely the buttons plus the guarantee that the service is running. That
 * split is what lets the alarm keep sounding when the screen is off.
 */
public class AlarmActivity extends Activity {

    private int alarmId = -1;
    private final Handler ticker = new Handler(Looper.getMainLooper());
    private TextView status;
    private Runnable tick;
    private MediaPlayer localPlayer;
    private int silentTicks = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        alarmId = getIntent() != null
                ? getIntent().getIntExtra(AlarmReceiver.EXTRA_ID, -1) : -1;

        showWhenLocked();
        keepScreenOn();
        setFinishOnTouchOutside(false);

        AlarmStore store = AlarmStore.getInstance(this);
        AlarmStore.AlarmInfo info = readInfo(store);
        store.log("ui", "id=" + alarmId + " full screen opened, alreadyRinging="
                + AlarmService.isRinging() + ", known=" + (info != null));

        if (info == null) {
            // Nothing is ringing any more (stopped from the notification).
            finish();
            return;
        }

        // Belt and braces: if Android refused the background service start
        // this is the first moment the app is allowed to start one.
        AlarmService.startRing(this, info);

        setContentView(buildView(info));
        startCountdown(info);
    }

    private AlarmStore.AlarmInfo readInfo(AlarmStore store) {
        if (alarmId < 0) return null;
        JSONObject raw = store.get(AlarmReceiver.AlarmStoreSection.RINGING,
                String.valueOf(alarmId));
        if (raw == null) {
            raw = store.get(AlarmReceiver.AlarmStoreSection.PENDING,
                    String.valueOf(alarmId));
        }
        return AlarmStore.AlarmInfo.fromJson(raw);
    }

    @SuppressWarnings("deprecation")
    private void showWhenLocked() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        w.setStatusBarColor(Color.parseColor("#05070d"));
        w.setNavigationBarColor(Color.parseColor("#05070d"));
    }

    private void keepScreenOn() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    private View buildView(AlarmStore.AlarmInfo info) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#05070d"));
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(24), dp(48), dp(24), dp(32));

        TextView kicker = new TextView(this);
        kicker.setText("REMINDER");
        kicker.setTextColor(Color.parseColor("#8b93a7"));
        kicker.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        kicker.setLetterSpacing(0.3f);
        kicker.setGravity(Gravity.CENTER);
        root.addView(wrap(kicker, dp(40)));

        TextView time = new TextView(this);
        time.setText(timeOf(info));
        time.setTextColor(Color.WHITE);
        time.setTextSize(TypedValue.COMPLEX_UNIT_SP, 56);
        time.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        time.setGravity(Gravity.CENTER);
        root.addView(wrap(time, dp(110)));

        TextView title = new TextView(this);
        title.setText(info.title == null || info.title.isEmpty() ? "Reminder" : info.title);
        title.setTextColor(Color.parseColor("#c7cdda"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setGravity(Gravity.CENTER);
        root.addView(wrap(title, dp(60)));

        if (info.body != null && !info.body.isEmpty()) {
            TextView body = new TextView(this);
            body.setText(info.body);
            body.setTextColor(Color.parseColor("#7f8798"));
            body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
            body.setGravity(Gravity.CENTER);
            root.addView(wrap(body, dp(70)));
        }

        status = new TextView(this);
        status.setTextColor(Color.parseColor("#f59e0b"));
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        status.setGravity(Gravity.CENTER);
        root.addView(wrap(status, dp(48)));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.addView(button(
                "Snooze " + info.snoozeMinutes + "m", "#1f2937", "#e5e7eb",
                v -> send(AlarmReceiver.ACTION_SNOOZE)));
        row.addView(spacer());
        row.addView(button(
                "Stop", "#111827", "#9ca3af",
                v -> send(AlarmReceiver.ACTION_STOP)));
        row.addView(spacer());
        row.addView(button(
                "Done", "#4f46e5", "#ffffff",
                v -> send(AlarmReceiver.ACTION_DONE)));
        root.addView(row);

        TextView hint = new TextView(this);
        hint.setText("Keeps ringing until you tap a button");
        hint.setTextColor(Color.parseColor("#4b5563"));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        hint.setGravity(Gravity.CENTER);
        root.addView(wrap(hint, dp(60)));

        return root;
    }

    private Button button(String label, String bg, String fg, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setTextColor(Color.parseColor(fg));
        b.setBackgroundColor(Color.parseColor(bg));
        b.setAllCaps(false);
        b.setPadding(dp(18), dp(16), dp(18), dp(16));
        b.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(6), 0, dp(6), 0);
        b.setLayoutParams(lp);
        return b;
    }

    private View spacer() {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(0, dp(1), 0f));
        return v;
    }

    private View wrap(View child, int height) {
        LinearLayout box = new LinearLayout(this);
        box.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, height);
        box.addView(child, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));
        child.setLayoutParams(lp);
        return box;
    }

    private void startCountdown(final AlarmStore.AlarmInfo info) {
        tick = new Runnable() {
            @Override
            public void run() {
                long left = Math.max(0L, info.until - System.currentTimeMillis());
                if (status != null) {
                    long mins = left / 60000;
                    long secs = (left % 60000) / 1000;
                    status.setText(String.format("Ringing… stops in %d:%02d", mins, secs));
                }

                // The service normally owns the audio. If Android refused to
                // start it and it has not come up within a couple of seconds,
                // ring from here so this screen is never a silent button
                // board. Hand back to the service the moment it appears.
                if (AlarmService.isRinging()) {
                    silentTicks = 0;
                    stopLocal();
                } else if (info.sound) {
                    silentTicks++;
                    if (silentTicks >= 2) startLocal();
                }

                if (left <= 0) {
                    finish();
                    return;
                }
                ticker.postDelayed(this, 1000L);
            }
        };
        ticker.post(tick);
    }

    /**
     * Looping tone used only while AlarmService has not started. The moment
     * the service reports it is ringing this is released, so the alarm never
     * sounds twice.
     */
    private void startLocal() {
        if (localPlayer != null) return;
        try {
            int res = getResources()
                    .getIdentifier("reminder_tone", "raw", getPackageName());
            if (res != 0) {
                localPlayer = MediaPlayer.create(this, res);
            }
            if (localPlayer == null) return;

            localPlayer.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            localPlayer.setLooping(true);
            localPlayer.start();
        } catch (Exception e) {
            localPlayer = null;
        }
    }

    private void stopLocal() {
        if (localPlayer == null) return;
        try {
            if (localPlayer.isPlaying()) localPlayer.stop();
            localPlayer.release();
        } catch (Exception ignored) {
        }
        localPlayer = null;
    }

    private void send(String action) {
        Intent intent = new Intent(this, AlarmReceiver.class);
        intent.setAction(action);
        intent.putExtra(AlarmReceiver.EXTRA_ID, alarmId);
        sendBroadcast(intent);

        if (AlarmReceiver.ACTION_DONE.equals(action)) {
            // The WebView may be asleep; open it so the JS marks it right away.
            Intent open = new Intent(this, com.reminderkrunga.app.MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(open);
        }
        finish();
    }

    private String timeOf(AlarmStore.AlarmInfo info) {
        long at = info.firedAt > 0 ? info.firedAt : info.at;
        return java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT)
                .format(new java.util.Date(at));
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,
                value, getResources().getDisplayMetrics()));
    }

    @Override
    protected void onDestroy() {
        ticker.removeCallbacksAndMessages(null);
        stopLocal();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // Leaving the screen does not silence the alarm: the notification
        // with its Stop button is still there.
        finish();
    }
}

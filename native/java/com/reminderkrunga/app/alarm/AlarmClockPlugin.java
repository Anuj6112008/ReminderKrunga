package com.reminderkrunga.app.alarm;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The JavaScript side of the alarm.
 *
 * JS keeps owning the schedule bookkeeping (repeats, snoozes, chains) and
 * hands us one job: "ring at this exact moment, with this text, even if the
 * screen is off". Everything after that - AlarmManager, the foreground
 * service, the full screen intent - is native.
 */
@CapacitorPlugin(name = "AlarmClock")
public class AlarmClockPlugin extends Plugin {

    private static final String TAG = "AlarmClockPlugin";

    private static final String PENDING = AlarmReceiver.AlarmStoreSection.PENDING;
    private static final String RINGING = AlarmReceiver.AlarmStoreSection.RINGING;
    private static final String SNOOZE = AlarmReceiver.AlarmStoreSection.SNOOZE;
    private static final String PENDING_DONE = AlarmReceiver.AlarmStoreSection.PENDING_DONE;

    @PluginMethod
    public void schedule(PluginCall call) {
        // getInteger/getDouble on PluginCall are null-safe; the JSObject
        // equivalents (JSONObject.getInt) throw when the key is missing.
        Integer idObj = call.getInt("id");
        Double atObj = call.getDouble("at");
        if (idObj == null || atObj == null) {
            call.reject("id and at are required");
            return;
        }

        JSObject data = call.getData();

        AlarmStore.AlarmInfo info = new AlarmStore.AlarmInfo();
        info.id = idObj;
        info.at = atObj.longValue();
        info.repeat = data.optString("repeat", "none");
        info.base = data.optLong("base", (long) info.at);
        info.title = data.optString("title", "");
        info.body = data.optString("body", "");
        info.ringMinutes = Math.max(1, data.optInt("ringMinutes", 5));
        info.snoozeMinutes = Math.max(1, data.optInt("snoozeMinutes", 5));
        info.sound = data.optBoolean("sound", true);
        info.vibrate = data.optBoolean("vibrate", true);

        AlarmStore store = AlarmStore.getInstance(getContext());
        store.put(PENDING, String.valueOf(info.id), info.toJson());
        store.log("js", "schedule id=" + info.id + " at=" + info.at
                + " repeat=" + info.repeat);

        boolean exact = AlarmScheduler.schedule(getContext(), info);

        JSObject out = new JSObject();
        out.put("ok", true);
        out.put("exact", exact);
        out.put("canScheduleExact", AlarmScheduler.canScheduleExact(getContext()));
        call.resolve(out);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Integer id = call.getInt("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }

        AlarmStore store = AlarmStore.getInstance(getContext());
        store.remove(PENDING, String.valueOf(id));
        store.remove(SNOOZE, String.valueOf(id));
        store.log("js", "cancel id=" + id);
        AlarmScheduler.cancel(getContext(), id);

        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Integer id = call.getInt("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }

        String key = String.valueOf(id);
        AlarmStore store = AlarmStore.getInstance(getContext());

        store.remove(RINGING, key);
        store.remove(SNOOZE, key);
        AlarmService.stopRinging(getContext(), id);

        // Deliberately leaves "pending" alone: for a one shot the receiver
        // already dropped it, and for a repeat that entry is the NEXT
        // occurrence. Cancelling the current ring is never its job - that
        // is what cancel() is for.
        call.resolve(new JSObject().put("ok", true));
    }

    @PluginMethod
    public void getState(PluginCall call) {
        AlarmStore store = AlarmStore.getInstance(getContext());

        JSObject out = new JSObject();
        out.put("available", true);
        out.put("exact", AlarmScheduler.canScheduleExact(getContext()));
        out.put("ringing", store.all(RINGING));
        out.put("pending", store.all(PENDING));
        out.put("snooze", store.all(SNOOZE));
        out.put("pendingDone", store.all(PENDING_DONE));
        out.put("log", store.readLog());
        out.put("androidO", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O);
        call.resolve(out);
    }

    @PluginMethod
    public void canScheduleExact(PluginCall call) {
        JSObject out = new JSObject();
        out.put("exact", AlarmScheduler.canScheduleExact(getContext()));
        call.resolve(out);
    }

    /**
     * Deep link to this app's system settings page, where the user can turn
     * off battery optimisation and (on Android 13+) allow exact alarms.
     * Going straight to ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS would
     * need another permission, so the settings page is the safe route.
     */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);

            JSObject out = new JSObject();
            out.put("ok", true);
            call.resolve(out);
        } catch (Exception e) {
            Log.w(TAG, "open settings failed: " + e.getMessage());
            call.reject("Could not open settings: " + e.getMessage());
        }
    }

    /** Lets JS ask whether the native alarm path is alive at all. */
    @PluginMethod
    public void ping(PluginCall call) {
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    /**
     * Whether Android will still show the alarm full screen over the lock
     * screen. When this is false the system silently downgrades us to a
     * plain heads-up notification, which looks like "the alarm never came
     * up" - so JS has to ask and send the user to the toggle.
     */
    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        JSObject out = new JSObject();
        out.put("ok", canUseFullScreenIntentNow());
        out.put("checkable", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S);
        call.resolve(out);
    }

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        boolean opened = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                Intent intent = new Intent(
                        Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                        Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                opened = true;
            } catch (Exception e) {
                Log.w(TAG, "full screen settings failed: " + e.getMessage());
            }
        }
        if (!opened) {
            opened = openNotificationSettings();
        }

        if (opened) call.resolve(new JSObject().put("ok", true));
        else call.reject("Could not open settings");
    }

    /**
     * True when the user has exempted us from battery optimisation. This
     * exemption is what lets the alarm ring from the background on phones
     * with aggressive battery managers.
     */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        call.resolve(new JSObject().put("ok", isIgnoringBatteryOptimizationsNow()));
    }

    /**
     * Deep link to the "Alarms & reminders" toggle. Without exact alarms the
     * ring moment drifts - and losing that exemption also loses the right to
     * start the ringing service from the background.
     */
    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        boolean opened = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                opened = true;
            } catch (Exception e) {
                Log.w(TAG, "exact alarm settings failed: " + e.getMessage());
            }
        }
        if (!opened) opened = openAppDetailsPage();

        if (opened) call.resolve(new JSObject().put("ok", true));
        else call.reject("Could not open settings");
    }

    /** Shows the system "let this app stop battery optimisation" dialog. */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        boolean opened = false;
        try {
            Intent intent = new Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            opened = true;
        } catch (Exception e) {
            Log.w(TAG, "battery dialog failed: " + e.getMessage());
        }
        if (!opened) {
            try {
                Intent intent = new Intent(
                        Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                opened = true;
            } catch (Exception e) {
                Log.w(TAG, "battery settings failed: " + e.getMessage());
            }
        }

        if (opened) call.resolve(new JSObject().put("ok", true));
        else call.reject("Could not open battery settings");
    }

    /** Exact-alarm + full screen state in one round trip for the UI banner. */
    @PluginMethod
    public void getAlarmPermissions(PluginCall call) {
        JSObject out = new JSObject();
        out.put("exact", AlarmScheduler.canScheduleExact(getContext()));
        out.put("fullScreen", canUseFullScreenIntentNow());
        out.put("battery", isIgnoringBatteryOptimizationsNow());
        out.put("notifications", notificationsAllowed());
        out.put("apiLevel", Build.VERSION.SDK_INT);
        call.resolve(out);
    }

    private boolean canUseFullScreenIntentNow() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                NotificationManager nm = (NotificationManager)
                        getContext().getSystemService(Context.NOTIFICATION_SERVICE);
                return nm == null || nm.canUseFullScreenIntent();
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                return getContext().checkSelfPermission(
                        "android.permission.USE_FULL_SCREEN_INTENT")
                        == PackageManager.PERMISSION_GRANTED;
            }
        } catch (Throwable t) {
            Log.w(TAG, "full screen check failed: " + t.getMessage());
        }
        return true;
    }

    private boolean isIgnoringBatteryOptimizationsNow() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager)
                        getContext().getSystemService(Context.POWER_SERVICE);
                return pm != null
                        && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            }
        } catch (Throwable t) {
            Log.w(TAG, "battery check failed: " + t.getMessage());
        }
        return true;
    }

    private boolean notificationsAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        try {
            return getContext().checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return true;
        }
    }

    private boolean openNotificationSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "notification settings failed: " + e.getMessage());
            return false;
        }
    }

    private boolean openAppDetailsPage() {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "app settings failed: " + e.getMessage());
            return false;
        }
    }

    /**
     * Clears a "marked done on the native screen" flag once JavaScript has
     * acted on it, so it is not applied twice on the next sync.
     */
    @PluginMethod
    public void ackDone(PluginCall call) {
        Integer id = call.getInt("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        AlarmStore.getInstance(getContext())
                .remove(PENDING_DONE, String.valueOf(id));
        call.resolve(new JSObject().put("ok", true));
    }
}

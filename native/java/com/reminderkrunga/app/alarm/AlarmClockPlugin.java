package com.reminderkrunga.app.alarm;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
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

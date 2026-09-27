package com.reminderkrunga.app.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

import java.util.Iterator;

/**
 * Re-arms every stored alarm after a reboot. AlarmManager throws away all
 * pending alarms when the device restarts, so without this the app would
 * simply go quiet.
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;

        String action = intent.getAction();
        boolean isBoot = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action);

        if (!isBoot) return;

        AlarmStore store = AlarmStore.getInstance(context);
        JSONObject ringing = store.all(AlarmStoreSection.RINGING);
        JSONObject pending = store.all(AlarmStoreSection.PENDING);

        // A ring in progress died with the reboot - drop it, the pending
        // entry (or the JS side on next launch) will take over.
        store.clear(AlarmStoreSection.RINGING);
        AlarmService.stopRinging(context, -1);

        int rearmed = 0;
        // JSONObject.keys() hands back an Iterator, not an Iterable, so this
        // has to be an explicit while-loop - a for-each would not compile.
        Iterator<String> keys = pending.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                AlarmStore.AlarmInfo info =
                        AlarmStore.AlarmInfo.fromJson(pending.optJSONObject(key));
                if (info == null) continue;
                if (AlarmScheduler.schedule(context, info)) rearmed++;
            } catch (Exception e) {
                Log.w(TAG, "re-arm failed for " + key + ": " + e.getMessage());
            }
        }

        Log.i(TAG, "boot action=" + action + " rearm=" + rearmed
                + " droppedRinging=" + ringing.length());
    }

    /** Convenience so AlarmReceiver.AlarmStoreSection reads stay short here. */
    public static final class AlarmStoreSection {
        public static final String RINGING = AlarmReceiver.AlarmStoreSection.RINGING;
        public static final String PENDING = AlarmReceiver.AlarmStoreSection.PENDING;

        private AlarmStoreSection() {
        }
    }
}

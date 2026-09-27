package com.reminderkrunga.app.alarm;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * JSON backed store so an alarm survives the WebView being killed.
 *
 * Sections
 *   pending    id -> alarm that has not fired yet (JS keeps this warm)
 *   ringing    id -> alarm currently sounding
 *   snooze     id -> {"at": ms} while a snooze is waiting
 *   pendingDone id -> reminder the user marked done from the native screen
 *                    while the JavaScript side was asleep
 */
public class AlarmStore {

    private static final String PREFS = "reminderkrunga_alarms";
    private static final String KEY = "state";

    private static AlarmStore instance;

    private final SharedPreferences prefs;
    private JSONObject cache;

    private AlarmStore(Context context) {
        prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static AlarmStore getInstance(Context context) {
        if (instance == null) {
            instance = new AlarmStore(context);
        }
        return instance;
    }

    private JSONObject root() {
        if (cache == null) {
            try {
                cache = new JSONObject(prefs.getString(KEY, "{}"));
            } catch (JSONException e) {
                cache = new JSONObject();
            }
        }
        return cache;
    }

    private void flush() {
        prefs.edit().putString(KEY, root().toString()).apply();
    }

    private JSONObject section(String name) {
        JSONObject root = root();
        JSONObject section = root.optJSONObject(name);
        if (section == null) {
            section = new JSONObject();
            try {
                root.put(name, section);
            } catch (JSONException ignored) {
            }
        }
        return section;
    }

    public void put(String section, String id, JSONObject value) {
        try {
            section(section).put(id, value);
        } catch (JSONException ignored) {
        }
        flush();
    }

    public JSONObject get(String section, String id) {
        return section(section).optJSONObject(id);
    }

    public void remove(String section, String id) {
        section(section).remove(id);
        flush();
    }

    public JSONObject all(String section) {
        return section(section);
    }

    public void clear(String section) {
        try {
            root().put(section, new JSONObject());
        } catch (JSONException ignored) {
        }
        flush();
    }

    /* ------------------------------------------------------------ event log */

    private static final String LOG_KEY = "eventlog";
    private static final int LOG_MAX = 60;

    /**
     * One durable diagnostic event.
     *
     * This is the point of the whole diagnostics build: it survives the
     * process being killed, so when an alarm misbehaves the log says whether
     * it was ever armed, whether the receiver ran, and whether Android
     * refused the service start - instead of us guessing.
     *
     * Events are kept one slot per (type, alarm): re-arming the same
     * reminder on every app open must never flush the real evidence out.
     */
    public void log(String tag, String message) {
        try {
            long now = System.currentTimeMillis();
            JSONArray arr = readLog();
            String id = extractId(message);

            int reuse = -1;
            for (int i = arr.length() - 1; i >= 0; i--) {
                JSONObject seen = arr.optJSONObject(i);
                if (seen == null) continue;
                if (!tag.equals(seen.optString("tag"))) continue;
                if (!id.equals(extractId(seen.optString("m")))) continue;
                reuse = i;
                break;
            }

            JSONObject entry;
            if (reuse >= 0) {
                entry = arr.optJSONObject(reuse);
                entry.put("t", now);
                entry.put("m", message);
                entry.put("n", entry.optInt("n", 1) + 1);
            } else {
                entry = new JSONObject();
                entry.put("t", now);
                entry.put("tag", tag);
                entry.put("m", message);
                entry.put("n", 1);
                arr.put(entry);
                while (arr.length() > LOG_MAX) {
                    arr.remove(0);
                }
            }

            prefs.edit().putString(LOG_KEY, arr.toString()).apply();
        } catch (JSONException ignored) {
        }
    }

    /** "id=12 at=..." -&gt; "12"; a message without an id -&gt; "". */
    private static String extractId(String message) {
        if (message == null) return "";
        int at = message.indexOf("id=");
        if (at < 0) return "";
        int start = at + 3;
        int end = start;
        while (end < message.length() && Character.isDigit(message.charAt(end))) end++;
        return end > start ? message.substring(start, end) : "";
    }

    public JSONArray readLog() {
        try {
            return new JSONArray(prefs.getString(LOG_KEY, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** Everything we need to fire, ring and re-arm one alarm. */
    public static class AlarmInfo {
        public int id;
        public long at;
        public String repeat = "none";
        public long base;
        public String title = "";
        public String body = "";
        public int ringMinutes = 5;
        public int snoozeMinutes = 5;
        public boolean sound = true;
        public boolean vibrate = true;
        public long firedAt;
        public long until;

        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("id", id);
                o.put("at", at);
                o.put("repeat", repeat);
                o.put("base", base);
                o.put("title", title);
                o.put("body", body == null ? "" : body);
                o.put("ringMinutes", ringMinutes);
                o.put("snoozeMinutes", snoozeMinutes);
                o.put("sound", sound);
                o.put("vibrate", vibrate);
                o.put("firedAt", firedAt);
                o.put("until", until);
            } catch (JSONException ignored) {
            }
            return o;
        }

        public static AlarmInfo fromJson(JSONObject o) {
            AlarmInfo info = new AlarmInfo();
            if (o == null) return null;
            info.id = o.optInt("id", -1);
            info.at = o.optLong("at", 0L);
            info.repeat = o.optString("repeat", "none");
            info.base = o.optLong("base", info.at);
            info.title = o.optString("title", "");
            info.body = o.optString("body", "");
            info.ringMinutes = Math.max(1, o.optInt("ringMinutes", 5));
            info.snoozeMinutes = Math.max(1, o.optInt("snoozeMinutes", 5));
            info.sound = o.optBoolean("sound", true);
            info.vibrate = o.optBoolean("vibrate", true);
            info.firedAt = o.optLong("firedAt", 0L);
            info.until = o.optLong("until", 0L);
            return info;
        }
    }
}

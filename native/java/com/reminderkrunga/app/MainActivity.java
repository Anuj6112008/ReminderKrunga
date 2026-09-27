package com.reminderkrunga.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.reminderkrunga.app.alarm.AlarmClockPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AlarmClockPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

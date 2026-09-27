#!/usr/bin/env node
/**
 * Injects the native alarm module into the Android project that
 * `npx cap add android` just generated.
 *
 * The android/ folder is gitignored (CI regenerates it every build), so the
 * native sources live in native/java and are copied in here at build time.
 *
 * Four idempotent steps:
 *   1. native/java/<package> -> android/app/src/main/java/<package>
 *   2. add the permissions the alarm needs to AndroidManifest.xml
 *   3. register the activity / service / receivers in AndroidManifest.xml
 *   4. pin Java 17 compileOptions in app/build.gradle
 *
 * Usage: node scripts/android-inject.js [androidDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.resolve(ROOT, process.argv[2] || 'android');
const SOURCE_DIR = path.join(ROOT, 'native', 'java');

const MANIFEST = path.join(ANDROID_DIR, 'app', 'src', 'main', 'AndroidManifest.xml');
const APP_BUILD_GRADLE = path.join(ANDROID_DIR, 'app', 'build.gradle');
const JAVA_ROOT = path.join(ANDROID_DIR, 'app', 'src', 'main', 'java');

const PERMISSIONS = [
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.VIBRATE',
  'android.permission.WAKE_LOCK',
];

function fail(msg) {
  console.error(`\n[android-inject] ERROR: ${msg}\n`);
  process.exit(1);
}

function readAppId() {
  const cfgPath = path.join(ROOT, 'capacitor.config.json');
  if (!fs.existsSync(cfgPath)) fail('capacitor.config.json not found');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.appId) fail('capacitor.config.json has no appId');
  return cfg.appId;
}

/* ---------------------------------------------------------------- step 1 */

function copySources(pkg) {
  const rel = pkg.replace(/\./g, '/');
  const src = path.join(SOURCE_DIR, rel);
  const dest = path.join(JAVA_ROOT, rel);

  if (!fs.existsSync(src)) {
    fail(`native sources missing for package "${pkg}" (expected ${src})`);
  }
  if (!fs.existsSync(JAVA_ROOT)) fail(`generated project has no java dir: ${JAVA_ROOT}`);

  fs.cpSync(src, dest, { recursive: true });

  const copied = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else copied.push(path.relative(ANDROID_DIR, full).replace(/\\/g, '/'));
    }
  };
  walk(dest);
  return copied;
}

/* ---------------------------------------------------------------- step 2 */

function addPermissions(xml) {
  // The end of the <manifest ...> opening tag. Matching the whole tag (not
  // just the first ">") matters: the <?xml ...?> declaration comes first.
  const tag = xml.match(/<manifest[\s\S]*?>/);
  if (!tag) fail('could not find the <manifest> opening tag');

  const insertAt = tag.index + tag[0].length;
  const missing = PERMISSIONS.filter(
    (perm) => !xml.includes(`android:name="${perm}"`)
  );
  if (!missing.length) return { xml, added: [] };

  const chunk = missing
    .map((perm) => `\n    <uses-permission android:name="${perm}" />`)
    .join('');

  return {
    xml: xml.slice(0, insertAt) + chunk + xml.slice(insertAt),
    added: missing,
  };
}

/* ---------------------------------------------------------------- step 3 */

function componentsBlock(pkg) {
  return `
        <!-- ===== Native alarm: full screen ring while the phone is locked ===== -->
        <activity
            android:name="${pkg}.alarm.AlarmActivity"
            android:exported="false"
            android:excludeFromRecents="true"
            android:noHistory="true"
            android:launchMode="singleInstance"
            android:showWhenLocked="true"
            android:turnScreenOn="true"
            android:theme="@android:style/Theme.DeviceDefault.NoActionBar" />

        <service
            android:name="${pkg}.alarm.AlarmService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />

        <receiver
            android:name="${pkg}.alarm.AlarmReceiver"
            android:exported="false" />

        <receiver
            android:name="${pkg}.alarm.BootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
                <action android:name="android.intent.action.TIME_SET" />
                <action android:name="android.intent.action.TIMEZONE_CHANGED" />
            </intent-filter>
        </receiver>
`;
}

function addComponents(xml, pkg) {
  if (xml.includes(`${pkg}.alarm.AlarmService`)) return { xml, added: [] };

  const closeIdx = xml.lastIndexOf('</application>');
  if (closeIdx < 0) fail('could not find </application> in AndroidManifest.xml');

  return {
    xml: xml.slice(0, closeIdx) + componentsBlock(pkg) + xml.slice(closeIdx),
    added: ['AlarmActivity', 'AlarmService', 'AlarmReceiver', 'BootReceiver'],
  };
}

/* ---------------------------------------------------------------- step 4 */

function patchBuildGradle() {
  const gradle = fs.readFileSync(APP_BUILD_GRADLE, 'utf8');
  if (gradle.includes('sourceCompatibility')) return false;

  const marker = /android\s*\{\s*\r?\n/;
  if (!marker.test(gradle)) {
    fail('could not find the "android {" block in app/build.gradle');
  }

  const patched = gradle.replace(marker, `android {
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
`);
  fs.writeFileSync(APP_BUILD_GRADLE, patched, 'utf8');
  return true;
}

/* ------------------------------------------------------------------ main */

function main() {
  if (!fs.existsSync(ANDROID_DIR)) {
    fail(`android project not found at ${ANDROID_DIR} - run "npx cap add android" first`);
  }
  if (!fs.existsSync(MANIFEST)) fail(`manifest not found at ${MANIFEST}`);
  if (!fs.existsSync(APP_BUILD_GRADLE)) fail(`build.gradle not found at ${APP_BUILD_GRADLE}`);

  const pkg = readAppId();
  const copied = copySources(pkg);

  let xml = fs.readFileSync(MANIFEST, 'utf8');
  const perm = addPermissions(xml);
  xml = perm.xml;
  const comp = addComponents(xml, pkg);
  xml = comp.xml;
  fs.writeFileSync(MANIFEST, xml, 'utf8');

  const gradlePatched = patchBuildGradle();

  console.log('[android-inject] package       :', pkg);
  console.log('[android-inject] java files    :', copied.length);
  copied.forEach((f) => console.log('    - ' + f));
  console.log('[android-inject] + permissions :',
    perm.added.length ? perm.added.join(', ') : '(all already present)');
  console.log('[android-inject] + components  :',
    comp.added.length ? comp.added.join(', ') : '(already present)');
  console.log('[android-inject] build.gradle  :',
    gradlePatched ? 'compileOptions = Java 17' : 'already patched');
  console.log('[android-inject] OK');
}

main();

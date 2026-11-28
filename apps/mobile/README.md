# LiveStar for Android

This Flutter Android app connects to the existing LiveStar website. Flutter
supplies the Arabic/English shell, navigation, retry interface and studio-exit
confirmation. An owned Kotlin WebView displays the real platform. This is a
web-integrated client, not a separate implementation of every backend or screen.

The website provides accounts, discovery, live playback, camera broadcasting,
free promotional DU gifts, profiles and authorized administration. The virtual
host is experimental: local inference needs a capable device, updated Android
System WebView, sufficient storage, internet and a visible hosting page. There
is no promise of 24-hour operation. The toolbar can open the current trusted
page in the phone's browser.

## Source

- lib/main.dart: Flutter application, navigation and failure states.
- lib/core/browser_bridge.dart: Flutter/native controller. No web-callable
  JavaScript bridge or authentication-token transfer.
- lib/core/browser_config.dart: compile-time public HTTPS deployment origin.
- android/app/src/main/kotlin/com/livestar/live/: native WebView, lifecycle,
  origin-scoped media prompts, photo picker and URL policy.
- android/app/src/main/AndroidManifest.xml: optional camera/microphone hardware,
  required permissions and disabled cleartext/backup.
- test/ and android/app/src/test/: Flutter/configuration and native URL tests.
  Widget tests explicitly fake the platform view; they do not claim real-device
  media integration coverage.

Unused phase placeholders, the unconnected API/token client and their
Dio/secure-storage dependencies were removed. The app uses the website's
first-party WebView cookie session and ships no sample account or password.

## Build

| Component | Version |
| --- | --- |
| Flutter | 3.38.3 |
| Java | 17 |
| Gradle | 8.14 |
| Android Gradle Plugin | 8.11.1 |
| Kotlin | 2.2.20 |
| Android compile/target SDK | 36 |
| Minimum Android SDK | 26, Android 8 |
| NDK | 28.2.13676358 |
| Application ID | com.livestar.live |

From apps/mobile on Linux/macOS with Flutter and Android SDK installed:

    flutter pub get
    dart format lib test
    flutter analyze
    flutter test
    flutter build apk --debug --dart-define=LIVESTAR_WEB_URL=https://livestar-live-nitq.onrender.com
    cd android
    ./gradlew testDebugUnitTest

The APK is build/app/outputs/flutter-apk/app-debug.apk. It uses Android's
development signing identity and is a test installation, not a Play release.
Local properties, build caches and signing keys must not be committed.

android/gradlew is a source-only bootstrap. It downloads official Gradle 8.14
over verified HTTPS, checks its fixed SHA-256 before extraction, and reuses an
owned cache. It requires curl, unzip, and sha256sum or shasum. A binary wrapper
JAR is unnecessary.

The Android workflow performs analysis, tests, compilation and artifact
inspection. Flutter/Android SDKs were not preinstalled in the shared workspace;
compilation evidence must come from that actual CI run, not source inspection.

## Google Play preparation

The release build has no signing configuration or debug-key fallback:

    flutter build appbundle --release --dart-define=LIVESTAR_WEB_URL=https://livestar-live-nitq.onrender.com
    flutter build apk --release --dart-define=LIVESTAR_WEB_URL=https://livestar-live-nitq.onrender.com

These produce unsigned artifacts for signing outside public source with the
owner's private upload identity. An unsigned AAB is not a finished Play upload.
APK and AAB signing require separate verification. Keep the same upload
identity for updates.

Source or build artifacts do not publish an app to Google Play. Publication
requires the owner's verified Play Console account, Play App Signing, listing,
screenshots, content rating, privacy-policy URL and accurate Data safety
declarations. Describe the actual account/profile data, public chat, selected
photos, audio/video and service providers used by the website.

Real-device checks must cover permission denial, broadcast/playback,
backgrounding, rotation and low-memory behavior before production release.
DU remains promotional and free. This app adds no card checkout, paid coins,
cash earnings or withdrawals.

## Runtime boundaries

- Only the configured HTTPS origin stays embedded. Lookalike hosts,
  credentials, other ports and local/executable schemes are refused. External
  HTTP(S) destinations open only after a main-frame user gesture or the
  toolbar's explicit browser action.
- Camera/microphone grants require the exact requesting origin, current
  top-level origin and actual Android OS permission. Geolocation and unknown
  media resources are denied.
- Profile images use the document picker with a temporary read grant. No broad
  storage or photo-library permission is requested.
- TLS errors are cancelled. Mixed content and file access are disabled.
  Third-party cookies are disabled; first-party cookies persist normally.
- Leaving the foreground dispatches existing media cleanup. Returning to a
  hosting route reloads current state instead of pretending the old broadcast
  still runs. The screen stays awake only on a visible hosting route.
- No background recording service, JavaScript credential bridge, native payment
  SDK or default administrator account is installed.

# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# --- Google Cast ---------------------------------------------------------
# CastOptionsProvider is referenced only by its class name in an AndroidManifest
# meta-data value, so R8 can't see the reference — keep it or Cast init fails in
# release builds.
-keep class com.communityiptv.player.CastOptionsProvider { *; }

# --- Tauri mobile plugins ------------------------------------------------
# Instantiated by class name from Rust (register_android_plugin) and dispatched
# by reflection, so keep the plugin classes and their @Command methods.
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keepclassmembers class * {
  @app.tauri.annotation.Command <methods>;
  @app.tauri.annotation.InvokeArg <fields>;
}
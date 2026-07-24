package com.communityiptv.player

import android.os.Bundle
import android.system.Os
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Point the Rust relay at the bundled ffmpeg. It ships as libffmpeg.so in
    // jniLibs and is extracted to nativeLibraryDir (see useLegacyPackaging in
    // build.gradle.kts), where it is a real, executable file the relay can spawn
    // for live-TV transcoding. resolve_ffmpeg() reads CTV_FFMPEG, so this must be
    // set BEFORE super.onCreate() triggers the native library / Tauri startup.
    try {
      val ffmpeg = applicationInfo.nativeLibraryDir + "/libffmpeg.so"
      Os.setenv("CTV_FFMPEG", ffmpeg, true)
      // The relay writes ffmpeg HLS segments under std::env::temp_dir(), which is
      // /tmp on Android (not writable). Redirect it to the app cache dir.
      Os.setenv("TMPDIR", cacheDir.absolutePath, true)
    } catch (e: Exception) {
      // Best-effort: without it, live transcoding is unavailable but VOD works.
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Android draws the WebView edge-to-edge (forced on API 35+). Pad the content
    // by the status/navigation-bar and cutout insets so the app UI isn't hidden
    // behind them. The padded strips show the dark window background; keep the
    // status-bar icons light for the dark UI.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = false
  }
}

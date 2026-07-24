package com.communityiptv.player

import android.os.Bundle
import android.system.Os
import androidx.activity.enableEdgeToEdge

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
  }
}

package com.communityiptv.player

import android.app.Activity
import android.os.Handler
import android.os.Looper
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaSeekOptions
import com.google.android.gms.cast.MediaStatus
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManager
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.cast.framework.media.RemoteMediaClient
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class CastStartArgs {
  lateinit var host: String        // carries the MediaRouter route id on Android
  var port: Int = 0
  var name: String? = null
  lateinit var url: String
  var content_type: String = "video/mp4"
  var title: String? = null
  var live: Boolean = false
}

@InvokeArg
class CastCmdArgs {
  lateinit var op: String
  var t: Double = 0.0
  var level: Double = 1.0
  var muted: Boolean = false
}

/**
 * Native Google Cast for the Android build. Mirrors the desktop relay's Cast
 * contract (src-tauri/src/cast.rs) so the existing /api/cast routes and the
 * useChromecast hook work unchanged: the relay proxies these commands here via
 * PluginHandle::run_mobile_plugin_async.
 *
 * A device (route) id is passed back and forth in the `host` field; `port` is
 * unused on Android (the Cast framework connects via MediaRouter, not host:port).
 *
 * All Cast SDK calls run on the main thread. When Google Play services is absent
 * (e.g. an AOSP emulator) initialization fails softly: `available` stays false,
 * device discovery returns empty, and start reports a friendly error — the app
 * never crashes.
 */
@TauriPlugin
class CastPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())

  private var castContext: CastContext? = null
  private var sessionManager: SessionManager? = null
  private var mediaRouter: MediaRouter? = null
  private var selector: MediaRouteSelector? = null
  private val routes = LinkedHashMap<String, MediaRouter.RouteInfo>()

  private var initTried = false
  private var available = false
  private var initError: String? = null

  private var currentHost: String? = null

  private val routerCallback = object : MediaRouter.Callback() {
    override fun onRouteAdded(router: MediaRouter, route: MediaRouter.RouteInfo) = refreshRoutes()
    override fun onRouteChanged(router: MediaRouter, route: MediaRouter.RouteInfo) = refreshRoutes()
    override fun onRouteRemoved(router: MediaRouter, route: MediaRouter.RouteInfo) = refreshRoutes()
  }

  /** Lazily bring up the Cast framework on the main thread. Safe to call often. */
  private fun ensureInit() {
    if (initTried) return
    initTried = true
    try {
      val ctx = CastContext.getSharedInstance(activity) // throws without Play services
      castContext = ctx
      sessionManager = ctx.sessionManager
      val router = MediaRouter.getInstance(activity)
      val sel = MediaRouteSelector.Builder()
        .addControlCategory(
          CastMediaControlIntent.categoryForCast(
            CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID
          )
        )
        .build()
      router.addCallback(sel, routerCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY)
      mediaRouter = router
      selector = sel
      available = true
    } catch (e: Throwable) {
      available = false
      initError = e.message ?: "Casting requires Google Play services"
    }
  }

  private fun refreshRoutes() {
    val router = mediaRouter ?: return
    val sel = selector ?: return
    routes.clear()
    // matchesSelector(cast) is true only for Cast-capable routes — the phone's
    // own default/bluetooth outputs don't advertise the Cast category.
    for (route in router.routes) {
      if (route.matchesSelector(sel)) routes[route.id] = route
    }
  }

  // -------------------------------------------------------------------------
  // Commands (each proxied from a loopback-only /api/cast/* relay route)
  // -------------------------------------------------------------------------

  /** Discover Cast devices. Resolves { devices: [{ name, host, port }] }. */
  @Command
  fun devices(invoke: Invoke) {
    main.post {
      ensureInit()
      if (!available) {
        invoke.resolve(JSObject().apply { put("devices", JSONArray()) })
        return@post
      }
      // Escalate to an active scan for the discovery window, then downgrade.
      mediaRouter?.addCallback(
        selector!!,
        routerCallback,
        MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY or MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN
      )
      main.postDelayed({
        mediaRouter?.addCallback(selector!!, routerCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY)
        refreshRoutes()
        val arr = JSONArray()
        for ((id, route) in routes) {
          arr.put(JSONObject().apply {
            put("name", route.name)
            put("host", id)
            put("port", 0)
          })
        }
        invoke.resolve(JSObject().apply { put("devices", arr) })
      }, 2500)
    }
  }

  /** Connect to a device (by route id in `host`) and load the media. */
  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(CastStartArgs::class.java)
    main.post {
      ensureInit()
      val sm = sessionManager
      if (!available || sm == null) {
        resolveError(invoke, initError ?: "Casting requires Google Play services")
        return@post
      }
      currentHost = args.host

      val existing = sm.currentCastSession
      if (existing != null && existing.isConnected) {
        loadMedia(existing, args, invoke, AtomicBoolean(false))
        return@post
      }

      val route = routes[args.host]
      if (route == null) {
        resolveError(invoke, "Cast device is no longer available")
        return@post
      }

      val done = AtomicBoolean(false)
      val listener = object : SessionManagerListener<CastSession> {
        override fun onSessionStarted(session: CastSession, sessionId: String) {
          sm.removeSessionManagerListener(this, CastSession::class.java)
          loadMedia(session, args, invoke, done)
        }
        override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) {
          sm.removeSessionManagerListener(this, CastSession::class.java)
          loadMedia(session, args, invoke, done)
        }
        override fun onSessionStartFailed(session: CastSession, error: Int) {
          sm.removeSessionManagerListener(this, CastSession::class.java)
          if (done.compareAndSet(false, true)) resolveError(invoke, "Cast session failed ($error)")
        }
        override fun onSessionStarting(session: CastSession) {}
        override fun onSessionEnding(session: CastSession) {}
        override fun onSessionEnded(session: CastSession, error: Int) {}
        override fun onSessionResuming(session: CastSession, sessionId: String) {}
        override fun onSessionResumeFailed(session: CastSession, error: Int) {}
        override fun onSessionSuspended(session: CastSession, reason: Int) {}
      }
      sm.addSessionManagerListener(listener, CastSession::class.java)
      mediaRouter?.selectRoute(route)

      main.postDelayed({
        if (done.compareAndSet(false, true)) {
          sm.removeSessionManagerListener(listener, CastSession::class.java)
          resolveError(invoke, "Cast connection timed out")
        }
      }, 15000)
    }
  }

  private fun loadMedia(session: CastSession, args: CastStartArgs, invoke: Invoke, done: AtomicBoolean) {
    val client = session.remoteMediaClient
    if (client == null) {
      if (done.compareAndSet(false, true)) resolveError(invoke, "Cast media client unavailable")
      return
    }
    val metadata = MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE)
    args.title?.let { metadata.putString(MediaMetadata.KEY_TITLE, it) }
    val info = MediaInfo.Builder(args.url)
      .setStreamType(if (args.live) MediaInfo.STREAM_TYPE_LIVE else MediaInfo.STREAM_TYPE_BUFFERED)
      .setContentType(args.content_type)
      .setMetadata(metadata)
      .build()
    val request = MediaLoadRequestData.Builder().setMediaInfo(info).setAutoplay(true).build()
    client.load(request)
    currentHost = args.host
    if (done.compareAndSet(false, true)) invoke.resolve(JSObject().apply { put("ok", true) })
  }

  /** Transport control: op = play | pause | seek | volume | mute | stop. */
  @Command
  fun cmd(invoke: Invoke) {
    val args = invoke.parseArgs(CastCmdArgs::class.java)
    main.post {
      val session = sessionManager?.currentCastSession
      val client = session?.remoteMediaClient
      try {
        when (args.op) {
          "play" -> client?.play()
          "pause" -> client?.pause()
          "seek" -> client?.seek(
            MediaSeekOptions.Builder().setPosition((args.t * 1000).toLong()).build()
          )
          "volume" -> session?.volume = args.level.coerceIn(0.0, 1.0)
          "mute" -> session?.isMute = args.muted
          "stop" -> {
            client?.stop()
            sessionManager?.endCurrentSession(true)
            currentHost = null
          }
        }
      } catch (_: Throwable) {
        // Best-effort transport; ignore transient Cast errors.
      }
      invoke.resolve(JSObject().apply { put("ok", true) })
    }
  }

  /** Current session snapshot, matching src-tauri/src/cast.rs CastSnapshot. */
  @Command
  fun status(invoke: Invoke) {
    main.post {
      ensureInit()
      val out = JSObject()
      val session = sessionManager?.currentCastSession
      val client = session?.remoteMediaClient
      if (session != null && session.isConnected && client != null && client.hasMediaSession()) {
        val duration = client.streamDuration
        out.put("active", true)
        out.put("device_name", session.castDevice?.friendlyName ?: "")
        out.put("host", currentHost ?: "")
        out.put("player_state", playerState(client))
        out.put("current_time", client.approximateStreamPosition / 1000.0)
        out.put("duration", if (duration > 0) duration / 1000.0 else 0.0)
        out.put("volume_level", runCatching { session.volume }.getOrDefault(1.0))
        out.put("muted", runCatching { session.isMute }.getOrDefault(false))
        out.put("error", JSONObject.NULL)
      } else {
        out.put("active", false)
      }
      invoke.resolve(out)
    }
  }

  private fun playerState(client: RemoteMediaClient): String = when (client.mediaStatus?.playerState) {
    MediaStatus.PLAYER_STATE_PLAYING -> "PLAYING"
    MediaStatus.PLAYER_STATE_PAUSED -> "PAUSED"
    MediaStatus.PLAYER_STATE_BUFFERING, MediaStatus.PLAYER_STATE_LOADING -> "BUFFERING"
    MediaStatus.PLAYER_STATE_IDLE -> "IDLE"
    else -> "UNKNOWN"
  }

  private fun resolveError(invoke: Invoke, message: String) {
    invoke.resolve(JSObject().apply {
      put("ok", false)
      put("error", message)
    })
  }
}

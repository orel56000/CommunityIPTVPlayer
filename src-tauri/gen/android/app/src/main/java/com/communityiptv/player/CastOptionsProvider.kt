package com.communityiptv.player

import android.content.Context
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider

/**
 * Registered via the `OPTIONS_PROVIDER_CLASS_NAME` manifest meta-data. Tells the
 * Cast framework to target the styled Default Media Receiver (app id CC1AD845),
 * which plays standard MP4/HLS media — the same receiver the desktop/web sender
 * uses (see DEFAULT_RECEIVER in src/hooks/useChromecast.ts).
 */
class CastOptionsProvider : OptionsProvider {
  override fun getCastOptions(context: Context): CastOptions =
    CastOptions.Builder()
      .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
      .build()

  override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}

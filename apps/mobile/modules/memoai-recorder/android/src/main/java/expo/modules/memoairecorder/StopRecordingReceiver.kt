package expo.modules.memoairecorder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Kept so a stop broadcast can still reach the service.
 * The notification Stop action does not use this receiver. It sends
 * PendingIntent.getForegroundService straight to [MemoAiRecorderService],
 * because a background startService from a broadcast is blocked on API 31+.
 */
class StopRecordingReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val stop = Intent(context, MemoAiRecorderService::class.java).apply {
      action = MemoAiRecorderService.ACTION_STOP
    }
    try {
      ContextCompat.startForegroundService(context, stop)
    } catch (error: Exception) {
      Log.w(TAG, "notification stop could not start the service", error)
    }
  }

  companion object {
    private const val TAG = "MemoAiRecorder"
  }
}

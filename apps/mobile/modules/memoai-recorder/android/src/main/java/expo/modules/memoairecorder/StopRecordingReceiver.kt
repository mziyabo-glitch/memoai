package expo.modules.memoairecorder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Notification Stop action. Not exported; only our PendingIntent can reach it. */
class StopRecordingReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val stop = Intent(context, MemoAiRecorderService::class.java).apply {
      action = MemoAiRecorderService.ACTION_STOP
    }
    try {
      context.startService(stop)
    } catch (_: IllegalStateException) {
      // The process was not allowed to start a service from the background.
      // The partial file stays on disk and is recovered on the next launch.
    }
  }
}

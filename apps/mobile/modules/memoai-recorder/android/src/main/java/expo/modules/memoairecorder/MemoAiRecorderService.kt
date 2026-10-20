package expo.modules.memoairecorder

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat

/**
 * Microphone foreground service.
 *
 * startForeground(type = MICROPHONE) runs before MediaRecorder starts.
 * The notification stays visible, including a Stop action. This service does
 * not take a wake lock and does not hide the system microphone indicator.
 * Screen-off and app switches are handled by the foreground service itself.
 */
class MemoAiRecorderService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val tick = object : Runnable {
    override fun run() {
      if (!RecorderController.serviceAlive) {
        return
      }
      RecorderController.persistElapsed(this@MemoAiRecorderService)
      handler.postDelayed(this, TICK_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> handleStart(intent)
      ACTION_PAUSE -> handlePause()
      ACTION_RESUME -> handleResume(intent)
      ACTION_STOP -> handleStop()
      else -> {
        // A restart without an explicit user action must not resume capture.
        if (!RecorderController.serviceAlive) {
          stopSelf()
        }
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    if (
      RecorderController.phase == Phase.RECORDING ||
      RecorderController.phase == Phase.PAUSED
    ) {
      RecorderController.interrupt(this, "service-destroyed")
      RecorderController.emit(this)
    }
    super.onDestroy()
  }

  private fun handleStart(intent: Intent) {
    // Required before capture, and required even if we then reject the start,
    // because startForegroundService was already called.
    promoteToForeground(recording = true)
    val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
    val authorizedAt = intent.getLongExtra(EXTRA_AUTHORIZED_AT, 0L)
    val fresh = authorizedAt != 0L && SystemClock.elapsedRealtime() - authorizedAt <= AUTHORIZATION_WINDOW_MS
    if (sessionId.isNullOrBlank() || !fresh) {
      RecorderController.rejectStart("Recording can only start while MemoAI is open")
      RecorderController.emit(this)
      shutdown()
      return
    }
    if (!RecorderController.hasPermissions(this)) {
      RecorderController.rejectStart("Microphone and notification permissions are required")
      RecorderController.emit(this)
      shutdown()
      return
    }
    val outcome = RecorderController.beginCapture(this, sessionId) {
      handler.post { interruptAndStop("audio-focus-or-capture-ended") }
    }
    RecorderController.emit(this)
    when (outcome) {
      StartOutcome.RECORDING -> {
        promoteToForeground(recording = true)
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, TICK_MS)
      }
      StartOutcome.INTERRUPTED,
      StartOutcome.REJECTED -> shutdown()
    }
  }

  private fun handlePause() {
    if (RecorderController.pause(this)) {
      promoteToForeground(recording = false)
    }
    RecorderController.emit(this)
  }

  private fun handleResume(intent: Intent) {
    val authorizedAt = intent.getLongExtra(EXTRA_AUTHORIZED_AT, 0L)
    val fresh = authorizedAt != 0L && SystemClock.elapsedRealtime() - authorizedAt <= AUTHORIZATION_WINDOW_MS
    if (!fresh || !isActivityForeground()) {
      RecorderController.prepareForCommand()
      RecorderController.lastError = "Resume the recording while MemoAI is open"
      RecorderController.emit(this)
      return
    }
    if (RecorderController.resume(this)) {
      promoteToForeground(recording = true)
    }
    RecorderController.emit(this)
  }

  private fun handleStop() {
    RecorderController.stop(this)
    RecorderController.emit(this)
    shutdown()
  }

  private fun interruptAndStop(reason: String) {
    RecorderController.interrupt(this, reason)
    RecorderController.emit(this)
    shutdown()
  }

  private fun promoteToForeground(recording: Boolean) {
    val notification = buildNotification(recording)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun shutdown() {
    handler.removeCallbacks(tick)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun isActivityForeground(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private fun buildNotification(recording: Boolean): Notification {
    ensureChannel()
    val stopIntent = Intent(this, StopRecordingReceiver::class.java)
    val stopPending = PendingIntent.getBroadcast(
      this,
      0,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val contentPending = launch?.let {
      PendingIntent.getActivity(
        this,
        1,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val title = if (recording) "MemoAI is recording" else "MemoAI recording is paused"
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText("Microphone is in use. Stop ends the recording.")
      .setSmallIcon(R.drawable.ic_stat_mic)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(R.drawable.ic_stat_mic, "Stop", stopPending)
    if (contentPending != null) {
      builder.setContentIntent(contentPending)
    }
    return builder.build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Recording",
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Shown while MemoAI is recording"
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      setShowBadge(true)
    }
    manager.createNotificationChannel(channel)
  }

  companion object {
    const val ACTION_START = "expo.modules.memoairecorder.START"
    const val ACTION_PAUSE = "expo.modules.memoairecorder.PAUSE"
    const val ACTION_RESUME = "expo.modules.memoairecorder.RESUME"
    const val ACTION_STOP = "expo.modules.memoairecorder.STOP"
    const val EXTRA_SESSION_ID = "sessionId"
    const val EXTRA_AUTHORIZED_AT = "authorizedAt"
    private const val CHANNEL_ID = "memoai-recording"
    private const val NOTIFICATION_ID = 4101
    private const val TICK_MS = 5_000L
    private const val AUTHORIZATION_WINDOW_MS = 3_000L
  }
}

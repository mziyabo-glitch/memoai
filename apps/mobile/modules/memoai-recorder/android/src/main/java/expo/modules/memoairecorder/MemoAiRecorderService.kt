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
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Microphone foreground service.
 *
 * startForeground(type = MICROPHONE) runs before MediaRecorder starts.
 * The notification stays visible, including a Stop action. This service does
 * not take a wake lock and does not hide the system microphone indicator.
 * Screen-off and app switches are handled by the foreground service itself.
 *
 * A short audio interruption pauses this same session and resumes when focus
 * returns. The service stays in the foreground during that pause. Only a
 * permanent focus loss or a capture failure ends the session.
 */
class MemoAiRecorderService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val tick = object : Runnable {
    override fun run() {
      if (!RecorderController.serviceAlive) {
        return
      }
      RecorderController.persistElapsed(this@MemoAiRecorderService)
      if (!RecorderController.serviceAlive) {
        RecorderController.emit(this@MemoAiRecorderService)
        shutdown()
        return
      }
      handler.postDelayed(this, TICK_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> handleStart(intent)
      ACTION_PAUSE -> handlePause(intent)
      ACTION_RESUME -> handleResume(intent)
      ACTION_STOP -> handleStop(intent)
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
    val op = intent.getLongExtra(EXTRA_OP, 0L)
    try {
      if (RecorderController.serviceAlive) {
        RecorderController.failCommand("A recording is already in progress")
        RecorderController.emit(this)
        return
      }
      try {
        promoteToForeground(recording = true)
      } catch (error: Exception) {
        Log.e(TAG, "startForeground failed", error)
        RecorderController.rejectStart("Could not show the recording notification")
        RecorderController.emit(this)
        stopSelf()
        return
      }
      val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
      val authorizedAt = intent.getLongExtra(EXTRA_AUTHORIZED_AT, 0L)
      val fresh = authorizedAt != 0L &&
        SystemClock.elapsedRealtime() - authorizedAt <= AUTHORIZATION_WINDOW_MS
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
      val outcome = try {
        RecorderController.beginCapture(this, sessionId, ::postCaptureSignal)
      } catch (error: Exception) {
        Log.e(TAG, "beginCapture failed", error)
        RecorderController.rejectStart(error.message ?: "Microphone capture failed")
        StartOutcome.REJECTED
      }
      RecorderController.emit(this)
      when (outcome) {
        StartOutcome.RECORDING -> {
          try {
            promoteToForeground(recording = true)
          } catch (error: Exception) {
            Log.e(TAG, "notification update failed after start", error)
          }
          handler.removeCallbacks(tick)
          handler.postDelayed(tick, TICK_MS)
        }
        StartOutcome.INTERRUPTED,
        StartOutcome.REJECTED,
        -> shutdown()
      }
    } finally {
      RecorderController.settle(op)
    }
  }

  private fun handlePause(intent: Intent) {
    val op = intent.getLongExtra(EXTRA_OP, 0L)
    try {
      if (RecorderController.pause(this)) {
        try {
          promoteToForeground(recording = false)
        } catch (error: Exception) {
          Log.e(TAG, "notification update failed after pause", error)
        }
      }
      RecorderController.emit(this)
      if (!RecorderController.serviceAlive) shutdown()
    } finally {
      RecorderController.settle(op)
    }
  }

  private fun handleResume(intent: Intent) {
    val op = intent.getLongExtra(EXTRA_OP, 0L)
    try {
      val authorizedAt = intent.getLongExtra(EXTRA_AUTHORIZED_AT, 0L)
      val fresh = authorizedAt != 0L &&
        SystemClock.elapsedRealtime() - authorizedAt <= AUTHORIZATION_WINDOW_MS
      if (!fresh || !isActivityForeground()) {
        RecorderController.failCommand("Resume the recording while MemoAI is open")
        RecorderController.emit(this)
        return
      }
      if (RecorderController.resume(this)) {
        try {
          promoteToForeground(recording = true)
        } catch (error: Exception) {
          Log.e(TAG, "notification update failed after resume", error)
        }
      }
      RecorderController.emit(this)
      if (!RecorderController.serviceAlive) shutdown()
    } finally {
      RecorderController.settle(op)
    }
  }

  /**
   * Stop from the in-app button or from the notification.
   * The notification uses PendingIntent.getForegroundService, so this command
   * must call startForeground before it stops, including on API 34.
   */
  private fun handleStop(intent: Intent) {
    val op = intent.getLongExtra(EXTRA_OP, 0L)
    try {
      try {
        promoteToForeground(recording = false)
      } catch (error: Exception) {
        Log.e(TAG, "startForeground before stop failed", error)
      }
      try {
        // A notification stop has no operation id. stop() keeps a session
        // that another stop already finished, saved or interrupted.
        RecorderController.stop(this)
      } catch (error: Exception) {
        Log.e(TAG, "stop failed", error)
        try {
          RecorderController.interrupt(this, "stop-failed")
        } catch (interruptError: Exception) {
          Log.e(TAG, "interrupt after stop failed", interruptError)
        }
        if (RecorderController.lastError == null) {
          RecorderController.failCommand(error.message ?: "The recording could not be saved")
        }
      }
      RecorderController.emit(this)
      try {
        shutdown()
      } catch (error: Exception) {
        Log.e(TAG, "shutdown failed", error)
        stopSelf()
      }
    } finally {
      RecorderController.settle(op)
    }
  }

  private fun postCaptureSignal(signal: CaptureSignal) {
    handler.post { onCaptureSignal(signal) }
  }

  private fun onCaptureSignal(signal: CaptureSignal) {
    try {
      when (signal) {
        CaptureSignal.SEGMENT_LIMIT -> {
          if (!RecorderController.rotate(this)) {
            if (!RecorderController.serviceAlive) shutdown()
          }
          RecorderController.emit(this)
        }
        CaptureSignal.TRANSIENT_FOCUS_LOSS -> {
          when (RecorderController.pauseForTransientFocus(this)) {
            TransientPauseResult.PAUSED -> {
              try {
                promoteToForeground(recording = false)
              } catch (error: Exception) {
                Log.e(TAG, "notification update failed during focus pause", error)
              }
              RecorderController.emit(this)
            }
            TransientPauseResult.FAILED -> interruptAndStop("capture-pause-failed")
            TransientPauseResult.ALREADY_HELD -> Unit
          }
        }
        CaptureSignal.FOCUS_GAIN -> {
          when (RecorderController.resumeAfterTransientFocus(this)) {
            TransientResumeResult.RESUMED -> {
              try {
                promoteToForeground(recording = true)
              } catch (error: Exception) {
                Log.e(TAG, "notification update failed after focus resume", error)
              }
              RecorderController.emit(this)
            }
            TransientResumeResult.FAILED -> interruptAndStop("capture-resume-failed")
            TransientResumeResult.IGNORED -> Unit
          }
        }
        CaptureSignal.PERMANENT_FOCUS_LOSS -> interruptAndStop("audio-focus-lost")
        CaptureSignal.CAPTURE_ERROR -> interruptAndStop("capture-error")
      }
    } catch (error: Exception) {
      Log.e(TAG, "capture signal failed", error)
    }
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
    val stopIntent = Intent(this, MemoAiRecorderService::class.java).apply {
      action = ACTION_STOP
    }
    val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    // User tap on a notification action may start a microphone FGS directly.
    // A broadcast receiver that then calls startService is blocked on API 31+.
    val stopPending = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      PendingIntent.getForegroundService(this, 0, stopIntent, pendingFlags)
    } else {
      PendingIntent.getService(this, 0, stopIntent, pendingFlags)
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      this.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
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
    val text = if (recording) {
      "Microphone is in use. Stop ends the recording."
    } else {
      "Paused. Stop ends the recording."
    }
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
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
    private const val TAG = "MemoAiRecorder"
    const val ACTION_START = "expo.modules.memoairecorder.START"
    const val ACTION_PAUSE = "expo.modules.memoairecorder.PAUSE"
    const val ACTION_RESUME = "expo.modules.memoairecorder.RESUME"
    const val ACTION_STOP = "expo.modules.memoairecorder.STOP"
    const val EXTRA_SESSION_ID = "sessionId"
    const val EXTRA_AUTHORIZED_AT = "authorizedAt"
    const val EXTRA_OP = "op"
    private const val CHANNEL_ID = "memoai-recording"
    private const val NOTIFICATION_ID = 4101
    private const val TICK_MS = 5_000L
    private const val AUTHORIZATION_WINDOW_MS = 3_000L
  }
}

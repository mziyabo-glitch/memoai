package expo.modules.memoairecorder

import android.app.ActivityManager
import android.content.Intent
import android.os.SystemClock
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class RecorderException(message: String) : CodedException(message)

class MemoAiRecorderModule : Module() {
  private var lifecycleForeground = true

  override fun definition() = ModuleDefinition {
    Name("MemoAiRecorder")

    Events("onChange")

    OnCreate {
      RecorderController.onStatus = { status ->
        sendEvent("onChange", status)
      }
    }

    OnDestroy {
      if (RecorderController.onStatus != null) {
        RecorderController.onStatus = null
      }
    }

    OnActivityEntersForeground {
      lifecycleForeground = true
    }

    OnActivityEntersBackground {
      lifecycleForeground = false
    }

    Function("getStatus") {
      RecorderController.statusMap(requireContext())
    }

    Function("reconcile") {
      RecorderController.reconcile(requireContext())
    }

    Function("listRecordings") {
      RecorderController.list(requireContext())
    }

    AsyncFunction("start") {
      val context = requireContext()
      assertForeground()
      if (!RecorderController.hasPermissions(context)) {
        throw RecorderException("Microphone and notification permissions are required")
      }
      if (RecorderController.serviceAlive) {
        throw RecorderException("A recording is already in progress")
      }
      val sessionId = UUID.randomUUID().toString()
      RecorderController.prepareForCommand()
      val intent = Intent(context, MemoAiRecorderService::class.java).apply {
        action = MemoAiRecorderService.ACTION_START
        putExtra(MemoAiRecorderService.EXTRA_SESSION_ID, sessionId)
        putExtra(MemoAiRecorderService.EXTRA_AUTHORIZED_AT, SystemClock.elapsedRealtime())
      }
      ContextCompat.startForegroundService(context, intent)
      RecorderController.awaitPhase(context, Phase.RECORDING, 5_000)
    }

    AsyncFunction("pause") {
      val context = requireContext()
      if (!RecorderController.serviceAlive || RecorderController.phase != Phase.RECORDING) {
        throw RecorderException("Nothing is recording")
      }
      RecorderController.prepareForCommand()
      context.startService(command(context, MemoAiRecorderService.ACTION_PAUSE))
      RecorderController.awaitPhase(context, Phase.PAUSED, 3_000)
    }

    AsyncFunction("resume") {
      val context = requireContext()
      assertForeground()
      if (!RecorderController.serviceAlive || RecorderController.phase != Phase.PAUSED) {
        throw RecorderException("Nothing is paused")
      }
      RecorderController.prepareForCommand()
      val intent = command(context, MemoAiRecorderService.ACTION_RESUME).apply {
        putExtra(MemoAiRecorderService.EXTRA_AUTHORIZED_AT, SystemClock.elapsedRealtime())
      }
      context.startService(intent)
      RecorderController.awaitPhase(context, Phase.RECORDING, 3_000)
    }

    AsyncFunction("stop") {
      val context = requireContext()
      val active = RecorderController.serviceAlive ||
        RecorderController.phase == Phase.RECORDING ||
        RecorderController.phase == Phase.PAUSED
      if (!active) {
        RecorderController.statusMap(context)
      } else {
        RecorderController.prepareForCommand()
        context.startService(command(context, MemoAiRecorderService.ACTION_STOP))
        RecorderController.awaitPhase(context, Phase.STOPPED, 4_000)
      }
    }
  }

  private fun command(context: android.content.Context, action: String): Intent {
    return Intent(context, MemoAiRecorderService::class.java).apply {
      this.action = action
    }
  }

  private fun requireContext(): android.content.Context {
    return appContext.reactContext
      ?: appContext.currentActivity
      ?: throw RecorderException("MemoAI is not open")
  }

  private fun assertForeground() {
    if (!lifecycleForeground || !isProcessForeground()) {
      throw RecorderException("Recording can only start while MemoAI is open")
    }
  }

  private fun isProcessForeground(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }
}

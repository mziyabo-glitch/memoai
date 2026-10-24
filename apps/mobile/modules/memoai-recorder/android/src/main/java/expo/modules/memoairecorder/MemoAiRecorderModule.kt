package expo.modules.memoairecorder

import android.app.ActivityManager
import android.content.Context
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

    AsyncFunction("hashLegacyFile") { id: String ->
      RecorderController.hashLegacyFile(requireContext(), id)
    }

    Function("listRecoveryFiles") {
      synchronized(RecorderController.lock) { RecoveryFiles.list(requireContext()) }
    }
    Function("storageBytes") {
      synchronized(RecorderController.lock) {
        RecordingStore.directory(requireContext()).listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L
      }
    }
    AsyncFunction("recoverFile") { name: String ->
      synchronized(RecorderController.lock) { RecoveryFiles.recover(requireContext(), name) }
    }
    AsyncFunction("exportRecoveryFile") { name: String ->
      assertForeground()
      synchronized(RecorderController.lock) { RecoveryFiles.export(requireContext(), name) }
    }
    AsyncFunction("deleteRecoveryFile") { name: String ->
      assertForeground()
      synchronized(RecorderController.lock) {
        if (!RecoveryFiles.requireFile(requireContext(), name).delete()) {
          throw RecorderException("Could not delete the recovery file")
        }
      }
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
      val op = RecorderController.openOperation()
      val intent = Intent(context, MemoAiRecorderService::class.java).apply {
        action = MemoAiRecorderService.ACTION_START
        putExtra(MemoAiRecorderService.EXTRA_SESSION_ID, sessionId)
        putExtra(MemoAiRecorderService.EXTRA_AUTHORIZED_AT, SystemClock.elapsedRealtime())
        putExtra(MemoAiRecorderService.EXTRA_OP, op)
      }
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (error: Exception) {
        RecorderController.rejectStart(error.message ?: "Could not start the recording service")
        RecorderController.settle(op)
        throw RecorderException(
          RecorderController.lastError ?: "Could not start the recording service",
        )
      }
      RecorderController.awaitSettled(context, op, Phase.RECORDING, 5_000)
    }

    AsyncFunction("pause") {
      val context = requireContext()
      val phase = RecorderController.phase
      // A transient-focus pause is already PAUSED. Pause must still run so the
      // user can take ownership and block the automatic resume.
      val canPause = RecorderController.serviceAlive &&
        (phase == Phase.RECORDING || phase == Phase.PAUSED)
      if (!canPause) {
        throw RecorderException("Nothing is recording")
      }
      val op = RecorderController.openOperation()
      try {
        context.startService(command(context, MemoAiRecorderService.ACTION_PAUSE, op))
      } catch (error: Exception) {
        RecorderController.failCommand(error.message ?: "Pause failed")
        RecorderController.settle(op)
        throw RecorderException(RecorderController.lastError ?: "Pause failed")
      }
      RecorderController.awaitSettled(context, op, Phase.PAUSED, 3_000)
    }

    AsyncFunction("resume") {
      val context = requireContext()
      assertForeground()
      if (!RecorderController.serviceAlive || RecorderController.phase != Phase.PAUSED) {
        throw RecorderException("Nothing is paused")
      }
      val op = RecorderController.openOperation()
      val intent = command(context, MemoAiRecorderService.ACTION_RESUME, op).apply {
        putExtra(MemoAiRecorderService.EXTRA_AUTHORIZED_AT, SystemClock.elapsedRealtime())
      }
      try {
        context.startService(intent)
      } catch (error: Exception) {
        RecorderController.failCommand(error.message ?: "Resume failed")
        RecorderController.settle(op)
        throw RecorderException(RecorderController.lastError ?: "Resume failed")
      }
      RecorderController.awaitSettled(context, op, Phase.RECORDING, 3_000)
    }

    AsyncFunction("stop") {
      val context = requireContext()
      val active = RecorderController.serviceAlive ||
        RecorderController.phase == Phase.RECORDING ||
        RecorderController.phase == Phase.PAUSED
      if (!active) {
        RecorderController.statusMap(context)
      } else {
        val op = RecorderController.openOperation()
        try {
          context.startService(command(context, MemoAiRecorderService.ACTION_STOP, op))
        } catch (error: Exception) {
          RecorderController.failCommand(error.message ?: "Stop failed")
          RecorderController.settle(op)
          throw RecorderException(RecorderController.lastError ?: "Stop failed")
        }
        RecorderController.awaitSettled(context, op, Phase.STOPPED, 4_000)
      }
    }
  }

  private fun command(context: Context, action: String, op: Long): Intent {
    return Intent(context, MemoAiRecorderService::class.java).apply {
      this.action = action
      putExtra(MemoAiRecorderService.EXTRA_OP, op)
    }
  }

  private fun requireContext(): Context {
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

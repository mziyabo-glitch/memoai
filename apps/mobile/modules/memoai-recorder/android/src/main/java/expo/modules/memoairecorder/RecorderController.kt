package expo.modules.memoairecorder

import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.File

internal enum class Phase(val wire: String) {
  IDLE("idle"),
  RECORDING("recording"),
  PAUSED("paused"),
  INTERRUPTED("interrupted"),
  STOPPED("stopped"),
}

internal enum class StartOutcome {
  RECORDING,
  INTERRUPTED,
  REJECTED,
}

/** Posted off the audio-focus thread. The service decides what to do. */
internal enum class CaptureSignal {
  TRANSIENT_FOCUS_LOSS,
  FOCUS_GAIN,
  PERMANENT_FOCUS_LOSS,
  CAPTURE_ERROR,
  SEGMENT_LIMIT,
}

internal enum class TransientPauseResult {
  PAUSED,
  ALREADY_HELD,
  FAILED,
}

internal enum class TransientResumeResult {
  RESUMED,
  IGNORED,
  FAILED,
}

/**
 * In-process source of truth for the microphone capture. The foreground
 * service mutates it. The JS module only reads it.
 *
 * Elapsed time excludes pauses. It is computed here, not in JavaScript.
 * A command settles an operation id. Callers wait for that id, then read
 * [lastError]. An already interrupted session is not a successful start.
 */
internal object RecorderController {
  private const val TAG = "MemoAiRecorder"
  val lock = Any()
  @Volatile var phase = Phase.IDLE
  @Volatile var serviceAlive = false
  @Volatile var lastError: String? = null
  @Volatile private var settledOp = 0L
  private var requestedOp = 0L
  private var activeId: String? = null
  private var accumulatedMs = 0L
  private var segmentStartedAt = 0L
  private var pausedByTransientFocus = false
  private var capture: SegmentCapture? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  var onStatus: ((Map<String, Any?>) -> Unit)? = null

  fun hasPermissions(context: Context): Boolean {
    val mic = ContextCompat.checkSelfPermission(
      context,
      android.Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED
    if (!mic) {
      return false
    }
    if (Build.VERSION.SDK_INT >= 33) {
      val notifications = ContextCompat.checkSelfPermission(
        context,
        android.Manifest.permission.POST_NOTIFICATIONS,
      ) == PackageManager.PERMISSION_GRANTED
      if (!notifications) {
        return false
      }
    }
    return true
  }


  fun openOperation(): Long = synchronized(lock) { lastError = null; ++requestedOp }
  fun settle(op: Long) = synchronized(lock) { if (op > settledOp) settledOp = op }
  fun failCommand(message: String) = synchronized(lock) { lastError = message }
  fun rejectStart(message: String) = synchronized(lock) {
    lastError = message
    if (phase != Phase.RECORDING && phase != Phase.PAUSED) serviceAlive = false
  }

  fun beginCapture(context: Context, sessionId: String, onSignal: (CaptureSignal) -> Unit): StartOutcome = synchronized(lock) {
    if (serviceAlive) {
      lastError = "A recording is already in progress"
      return StartOutcome.REJECTED
    }
    if (!requestAudioFocus(context, onSignal)) {
      abandonFocusLocked(context)
      lastError = "Audio focus was not granted"
      return StartOutcome.REJECTED
    }
    val journal = journal(context)
    val next = SegmentCapture(journal, SegmentSession(sessionId, System.currentTimeMillis()), { file ->
      AndroidAudioPart(context, file,
        { onSignal(CaptureSignal.SEGMENT_LIMIT) },
        { onSignal(CaptureSignal.CAPTURE_ERROR) })
    }, SystemClock::elapsedRealtime)
    capture = next
    activeId = sessionId
    accumulatedMs = 0
    pausedByTransientFocus = false
    try {
      next.start()
      segmentStartedAt = SystemClock.elapsedRealtime()
      phase = Phase.RECORDING
      serviceAlive = true
      lastError = null
      StartOutcome.RECORDING
    } catch (error: Exception) {
      next.release()
      phase = Phase.INTERRUPTED
      serviceAlive = false
      lastError = error.message ?: "Recording could not start"
      try { next.persist(phase.wire) } catch (_: Exception) { /* Startup reconciliation retains intent. */ }
      abandonFocusLocked(context)
      StartOutcome.INTERRUPTED
    }
  }

  fun pause(context: Context): Boolean = synchronized(lock) {
    if (phase != Phase.RECORDING && phase != Phase.PAUSED) {
      lastError = "Nothing is recording"; return false
    }
    try {
      capture!!.pause()
      if (phase == Phase.RECORDING) accumulatedMs += SystemClock.elapsedRealtime() - segmentStartedAt
      pausedByTransientFocus = false
      phase = Phase.PAUSED
      capture!!.persist(phase.wire)
      lastError = null
      true
    } catch (error: Exception) {
      interrupt(context, error.message ?: "Pause failed")
      false
    }
  }

  fun pauseForTransientFocus(context: Context): TransientPauseResult = synchronized(lock) {
    if (phase != Phase.RECORDING) return TransientPauseResult.ALREADY_HELD
    if (!pause(context)) return TransientPauseResult.FAILED
    pausedByTransientFocus = true
    TransientPauseResult.PAUSED
  }

  fun resume(context: Context): Boolean = synchronized(lock) {
    if (phase != Phase.PAUSED) { lastError = "Nothing is paused"; return false }
    if (!hasPermissions(context)) {
      interrupt(context, "Microphone or notification permission was revoked"); return false
    }
    try {
      capture!!.resume()
      segmentStartedAt = SystemClock.elapsedRealtime()
      pausedByTransientFocus = false
      phase = Phase.RECORDING
      capture!!.persist(phase.wire)
      lastError = null
      true
    } catch (error: Exception) {
      interrupt(context, error.message ?: "Resume failed")
      false
    }
  }

  fun resumeAfterTransientFocus(context: Context): TransientResumeResult = synchronized(lock) {
    if (!pausedByTransientFocus || phase != Phase.PAUSED) return TransientResumeResult.IGNORED
    if (resume(context)) TransientResumeResult.RESUMED else TransientResumeResult.FAILED
  }

  fun rotate(context: Context): Boolean = synchronized(lock) {
    if (!serviceAlive || (phase != Phase.RECORDING && phase != Phase.PAUSED)) return false
    if (!hasPermissions(context)) {
      interrupt(context, "Microphone or notification permission was revoked"); return false
    }
    try {
      if (capture?.rotate() == true) {
        accumulatedMs = capture!!.session.durationMs
        segmentStartedAt = SystemClock.elapsedRealtime()
      }
      true
    } catch (error: Exception) {
      interrupt(context, error.message ?: "Could not save the next audio section")
      false
    }
  }

  fun stop(context: Context): Boolean = synchronized(lock) {
    if (phase == Phase.STOPPED) { lastError = null; return true }
    if (phase == Phase.INTERRUPTED) return false
    if (!serviceAlive) { lastError = "Nothing is recording"; return false }
    finish(context, null)
    phase == Phase.STOPPED
  }

  fun interrupt(context: Context, reason: String) = synchronized(lock) {
    if (serviceAlive || phase == Phase.RECORDING || phase == Phase.PAUSED) finish(context, reason)
  }

  private fun finish(context: Context, reason: String?) {
    serviceAlive = false
    pausedByTransientFocus = false
    var failure = reason
    try { capture?.stop() } catch (error: Exception) {
      failure = error.message ?: "Some audio could not be finalized; files were kept"
    } finally {
      capture?.release()
      abandonFocusLocked(context)
    }
    accumulatedMs = capture?.session?.durationMs ?: accumulatedMs
    val session = capture?.session
    val complete = session != null && session.segments.isNotEmpty() && session.segments.all { it.complete }
    phase = if (failure == null && complete) Phase.STOPPED else Phase.INTERRUPTED
    lastError = failure ?: if (complete) null else "Incomplete audio kept for recovery"
    try { capture?.persist(phase.wire) } catch (_: Exception) {
      phase = Phase.INTERRUPTED
      lastError = "Could not save the recording journal; audio kept for recovery"
    }
  }

  fun persistElapsed(context: Context) = synchronized(lock) {
    if (serviceAlive && !hasPermissions(context)) interrupt(context, "Recording permission was revoked")
    // Only transitions write the journal. Duration of each committed part is authoritative.
  }

  fun reconcile(context: Context): Map<String, Any?> = synchronized(lock) {
    val live = if (serviceAlive) activeId else null
    RecordingStore.markInterruptedIfOrphaned(context, live)
    val store = journal(context)
    val sessions = store.readAll().map { if (it.id == live) it else store.reconcile(it) }
    if (!serviceAlive) {
      val latest = sessions.maxByOrNull { it.startedAtMs }
      if (latest != null && (activeId == latest.id || activeId == null)) {
        activeId = latest.id
        accumulatedMs = latest.durationMs
        phase = if (latest.state == "stopped") Phase.STOPPED else Phase.INTERRUPTED
      } else if (activeId == null) {
        RecordingStore.readAll(context).maxByOrNull { it.updatedAtMs }?.let {
          activeId = it.id
          accumulatedMs = it.elapsedMs
          phase = if (it.state == "stopped") Phase.STOPPED else Phase.INTERRUPTED
        }
      }
    }
    statusMap(context)
  }

  /** Hash a legacy single file once, when an upload starts. Not used on the library timer. */
  fun hashLegacyFile(context: Context, id: String): String = synchronized(lock) {
    val meta = RecordingStore.readAll(context).firstOrNull { it.id == id }
      ?: throw RecorderException("That recording is not a single file on this phone")
    val file = RecordingStore.fileFor(context, meta.fileName)
    if (!file.isFile) throw RecorderException("The audio file is missing")
    SegmentJournal.sha256(file)
  }

  fun list(context: Context): List<Map<String, Any?>> = synchronized(lock) {
    val legacy = RecordingStore.readAll(context).map { meta ->
      val file = RecordingStore.fileFor(context, meta.fileName)
      val playable = meta.state != "recording" && meta.state != "paused" && !meta.corrupt &&
        SegmentJournal.audioDuration(file) != null
      val uri = if (playable) RecordingStore.uriFor(context, meta.fileName) else null
      mapOf<String, Any?>("id" to meta.id, "state" to meta.state, "elapsedMs" to meta.elapsedMs,
        "startedAtMs" to meta.startedAtMs, "updatedAtMs" to meta.updatedAtMs,
        "playable" to playable, "corrupt" to !playable, "sizeBytes" to file.length(),
        "fileUri" to uri, "parts" to if (uri != null) listOf(mapOf(
          "fileUri" to uri, "durationMs" to meta.elapsedMs, "sizeBytes" to file.length(),
          "sha256" to null, "finished" to true)) else emptyList<Any>(),
        "incompleteParts" to if (playable) 0 else 1, "rotationGapMs" to 0)
    }
    val store = journal(context)
    val segmented = store.readAll().map { session ->
      val parts = session.segments.filter { it.complete && store.file(it.fileName).isFile }
      val live = serviceAlive && session.id == activeId
      val uris = parts.map { mapOf(
        "fileUri" to android.net.Uri.fromFile(store.file(it.fileName)).toString(),
        "durationMs" to it.durationMs, "sizeBytes" to it.sizeBytes,
        "sha256" to it.sha256, "finished" to true) }
      mapOf<String, Any?>("id" to session.id, "state" to if (live) phase.wire else session.state,
        "elapsedMs" to if (live) elapsedLocked() else session.durationMs,
        "startedAtMs" to session.startedAtMs, "updatedAtMs" to session.startedAtMs,
        "playable" to (!live && parts.isNotEmpty()), "corrupt" to (parts.size != session.segments.size),
        "sizeBytes" to session.segments.sumOf { store.file(it.fileName).length() + store.file(it.fileName + ".partial").length() },
        "fileUri" to uris.firstOrNull()?.get("fileUri"), "parts" to uris,
        "incompleteParts" to (session.segments.size - parts.size), "rotationGapMs" to session.rotationGapMs)
    }
    (legacy + segmented).sortedByDescending { it["startedAtMs"] as Long }
  }

  fun statusMap(context: Context): Map<String, Any?> = synchronized(lock) {
    mapOf("serviceAlive" to serviceAlive, "phase" to phase.wire, "sessionId" to activeId,
      "elapsedMs" to elapsedLocked(), "fileUri" to null, "pausedByFocus" to pausedByTransientFocus,
      "lastError" to lastError)
  }
  fun emit(context: Context) { onStatus?.invoke(statusMap(context)) }
  private fun journal(context: Context) = SegmentJournal(RecordingStore.directory(context))
  private fun elapsedLocked(): Long = if (phase == Phase.RECORDING && serviceAlive)
    accumulatedMs + (SystemClock.elapsedRealtime() - segmentStartedAt) else accumulatedMs

  fun awaitSettled(context: Context, op: Long, target: Phase, timeoutMs: Long): Map<String, Any?> {
    if (op <= 0L) {
      throw RecorderException("The recording service did not respond")
    }
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      if (settledOp >= op) {
        return outcome(context, target)
      }
      Thread.sleep(20)
    }
    if (settledOp >= op) {
      return outcome(context, target)
    }
    throw RecorderException(lastError ?: "The recording service did not respond")
  }

  private fun outcome(context: Context, target: Phase): Map<String, Any?> {
    val failure = lastError
    if (failure != null) {
      throw RecorderException(failure)
    }
    val reached = phase == target && (target != Phase.RECORDING || serviceAlive)
    if (!reached) {
      throw RecorderException("The recording did not enter ${target.wire}")
    }
    return statusMap(context)
  }


  private fun requestAudioFocus(context: Context, onSignal: (CaptureSignal) -> Unit): Boolean {
    val manager = context.getSystemService(AudioManager::class.java) ?: return false
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      val signal = when (change) {
        AudioManager.AUDIOFOCUS_LOSS -> CaptureSignal.PERMANENT_FOCUS_LOSS
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,
        -> CaptureSignal.TRANSIENT_FOCUS_LOSS
        AudioManager.AUDIOFOCUS_GAIN -> CaptureSignal.FOCUS_GAIN
        else -> null
      }
      if (signal != null) {
        onSignal(signal)
      }
    }
    focusListener = listener
    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener(listener)
        .build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(
        listener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN,
      )
    }
    return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocusLocked(context: Context) {
    val manager = context.getSystemService(AudioManager::class.java) ?: return
    val request = focusRequest
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
      manager.abandonAudioFocusRequest(request)
    } else if (focusListener != null) {
      @Suppress("DEPRECATION")
      manager.abandonAudioFocus(focusListener)
    }
    focusRequest = null
    focusListener = null
  }


}

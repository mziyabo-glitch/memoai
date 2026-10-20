package expo.modules.memoairecorder

import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.media.MediaRecorder
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

  @Volatile var phase: Phase = Phase.IDLE
  @Volatile var serviceAlive: Boolean = false
  @Volatile var lastError: String? = null
  @Volatile private var settledOp: Long = 0

  var onStatus: ((Map<String, Any?>) -> Unit)? = null

  private var requestedOp: Long = 0
  private var activeId: String? = null
  private var activeFileName: String? = null
  private var startedAtMs: Long = 0
  private var accumulatedMs: Long = 0
  private var segmentStartedAt: Long = 0
  private var activePlayable: Boolean = false
  private var activeCorrupt: Boolean = false
  private var pausedByTransientFocus: Boolean = false
  private var recorder: MediaRecorder? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null

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

  /** Next command. Clears a previous error so only this command's result counts. */
  fun openOperation(): Long {
    synchronized(lock) {
      requestedOp += 1
      lastError = null
      return requestedOp
    }
  }

  fun settle(op: Long) {
    if (op <= 0L) {
      return
    }
    synchronized(lock) {
      if (op > settledOp) {
        settledOp = op
      }
    }
  }

  fun failCommand(message: String) {
    synchronized(lock) {
      lastError = message
    }
  }

  /**
   * A start that never began capture. Keeps an existing interrupted session
   * and its file. Sets [lastError] so the waiting command fails.
   */
  fun rejectStart(message: String) {
    synchronized(lock) {
      lastError = message
      if (phase == Phase.RECORDING || phase == Phase.PAUSED) {
        return
      }
      serviceAlive = false
      if (phase != Phase.INTERRUPTED) {
        phase = Phase.IDLE
      }
    }
  }

  fun beginCapture(
    context: Context,
    sessionId: String,
    onSignal: (CaptureSignal) -> Unit,
  ): StartOutcome {
    synchronized(lock) {
      if (serviceAlive && (phase == Phase.RECORDING || phase == Phase.PAUSED)) {
        lastError = "A recording is already in progress"
        return StartOutcome.REJECTED
      }
      val fileName = "$sessionId.m4a"
      val file = RecordingStore.fileFor(context, fileName)
      val created = createRecorder(context)
      var started = false
      try {
        if (!requestAudioFocus(context, onSignal)) {
          releaseQuietly(created)
          abandonFocusLocked(context)
          lastError = "Audio focus was not granted"
          serviceAlive = false
          if (phase != Phase.INTERRUPTED) {
            phase = Phase.IDLE
          }
          return StartOutcome.REJECTED
        }
        created.setAudioSource(MediaRecorder.AudioSource.MIC)
        created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        created.setAudioEncodingBitRate(128_000)
        created.setAudioSamplingRate(44_100)
        created.setAudioChannels(1)
        created.setOutputFile(file.absolutePath)
        created.setOnErrorListener { _, what, extra ->
          Log.w(TAG, "MediaRecorder error $what/$extra")
          onSignal(CaptureSignal.CAPTURE_ERROR)
        }
        created.prepare()
        // Microphone capture starts only after the service has called
        // startForeground. The service enforces that order.
        created.start()
        started = true
        recorder = created
        activeId = sessionId
        activeFileName = fileName
        startedAtMs = System.currentTimeMillis()
        accumulatedMs = 0
        segmentStartedAt = SystemClock.elapsedRealtime()
        activePlayable = false
        activeCorrupt = false
        pausedByTransientFocus = false
        phase = Phase.RECORDING
        serviceAlive = true
        lastError = null
        persistLocked(context)
        Log.i(TAG, "capture started")
        return StartOutcome.RECORDING
      } catch (error: Exception) {
        Log.e(TAG, "capture failed", error)
        var finalized = false
        if (started) {
          try {
            created.stop()
            finalized = true
          } catch (stopError: RuntimeException) {
            Log.w(TAG, "MediaRecorder.stop failed", stopError)
          }
        }
        releaseQuietly(created)
        recorder = null
        abandonFocusLocked(context)
        serviceAlive = false
        pausedByTransientFocus = false
        if (file.exists() && file.length() > 0L) {
          activeId = sessionId
          activeFileName = fileName
          startedAtMs = System.currentTimeMillis()
          accumulatedMs = 0
          val playable = finalized && mediaLooksPlayable(file)
          activePlayable = playable
          activeCorrupt = !playable
          phase = Phase.INTERRUPTED
          lastError = error.message ?: "Microphone capture failed"
          persistLocked(context)
          return StartOutcome.INTERRUPTED
        }
        deleteIfEmpty(file)
        lastError = error.message ?: "Microphone capture failed"
        if (phase != Phase.INTERRUPTED) {
          phase = Phase.IDLE
        }
        return StartOutcome.REJECTED
      }
    }
  }

  fun pause(context: Context): Boolean {
    synchronized(lock) {
      val current = recorder
      if (phase == Phase.PAUSED && current != null) {
        // Already paused, including a transient-focus pause. The user now
        // owns the pause, so a later focus gain must not resume capture.
        pausedByTransientFocus = false
        lastError = null
        persistLocked(context)
        return true
      }
      if (phase != Phase.RECORDING || current == null) {
        lastError = "Nothing is recording"
        return false
      }
      try {
        current.pause()
      } catch (error: RuntimeException) {
        Log.w(TAG, "MediaRecorder.pause failed", error)
        lastError = "Pause failed"
        return false
      }
      accumulatedMs += SystemClock.elapsedRealtime() - segmentStartedAt
      pausedByTransientFocus = false
      phase = Phase.PAUSED
      serviceAlive = true
      lastError = null
      persistLocked(context)
      Log.i(TAG, "paused at $accumulatedMs")
      return true
    }
  }

  /**
   * Another app took audio briefly. Pause capture and keep this session.
   * A pause the user already requested is left alone, so focus returning
   * does not resume it.
   */
  fun pauseForTransientFocus(context: Context): TransientPauseResult {
    synchronized(lock) {
      val current = recorder
      if (phase != Phase.RECORDING || current == null) {
        return TransientPauseResult.ALREADY_HELD
      }
      try {
        current.pause()
      } catch (error: RuntimeException) {
        Log.w(TAG, "MediaRecorder.pause failed during focus loss", error)
        return TransientPauseResult.FAILED
      }
      accumulatedMs += SystemClock.elapsedRealtime() - segmentStartedAt
      pausedByTransientFocus = true
      phase = Phase.PAUSED
      serviceAlive = true
      lastError = null
      persistLocked(context)
      Log.i(TAG, "paused for transient audio focus at $accumulatedMs")
      return TransientPauseResult.PAUSED
    }
  }

  fun resume(context: Context): Boolean {
    synchronized(lock) {
      val current = recorder
      if (phase != Phase.PAUSED || current == null) {
        lastError = "Nothing is paused"
        return false
      }
      try {
        current.resume()
      } catch (error: RuntimeException) {
        Log.w(TAG, "MediaRecorder.resume failed", error)
        lastError = "Resume failed"
        return false
      }
      pausedByTransientFocus = false
      segmentStartedAt = SystemClock.elapsedRealtime()
      phase = Phase.RECORDING
      serviceAlive = true
      lastError = null
      persistLocked(context)
      Log.i(TAG, "resumed")
      return true
    }
  }

  /** Resume only the pause this controller took for transient focus loss. */
  fun resumeAfterTransientFocus(context: Context): TransientResumeResult {
    synchronized(lock) {
      val current = recorder
      if (!pausedByTransientFocus || phase != Phase.PAUSED || current == null) {
        return TransientResumeResult.IGNORED
      }
      try {
        current.resume()
      } catch (error: RuntimeException) {
        Log.w(TAG, "MediaRecorder.resume failed after focus gain", error)
        return TransientResumeResult.FAILED
      }
      pausedByTransientFocus = false
      segmentStartedAt = SystemClock.elapsedRealtime()
      phase = Phase.RECORDING
      serviceAlive = true
      lastError = null
      persistLocked(context)
      Log.i(TAG, "resumed after transient audio focus")
      return TransientResumeResult.RESUMED
    }
  }

  fun stop(context: Context): Boolean {
    synchronized(lock) {
      if (phase != Phase.RECORDING && phase != Phase.PAUSED) {
        lastError = "Nothing is recording"
        return false
      }
      if (phase == Phase.RECORDING) {
        accumulatedMs += SystemClock.elapsedRealtime() - segmentStartedAt
      }
      pausedByTransientFocus = false
      val finalized = finalizeRecorderLocked()
      serviceAlive = false
      abandonFocusLocked(context)
      val file = activeFile(context)
      val playable = finalized && file != null && mediaLooksPlayable(file)
      if (playable) {
        activePlayable = true
        activeCorrupt = false
        phase = Phase.STOPPED
        lastError = null
        persistLocked(context)
        Log.i(TAG, "stopped at $accumulatedMs")
        return true
      }
      val kept = file != null && file.exists() && file.length() > 0L
      activePlayable = false
      activeCorrupt = kept
      phase = Phase.INTERRUPTED
      lastError = if (kept) {
        "The recording was kept, but the file may be incomplete"
      } else {
        "The recording could not be saved"
      }
      persistLocked(context)
      Log.w(TAG, "stop kept partial file=$kept finalized=$finalized")
      return false
    }
  }

  fun interrupt(context: Context, reason: String) {
    synchronized(lock) {
      if (phase != Phase.RECORDING && phase != Phase.PAUSED) {
        serviceAlive = false
        return
      }
      if (phase == Phase.RECORDING) {
        accumulatedMs += SystemClock.elapsedRealtime() - segmentStartedAt
      }
      pausedByTransientFocus = false
      val finalized = finalizeRecorderLocked()
      serviceAlive = false
      val file = activeFile(context)
      val playable = finalized && file != null && mediaLooksPlayable(file)
      if (playable) {
        activePlayable = true
        activeCorrupt = false
      } else {
        activePlayable = false
        activeCorrupt = file != null && file.exists() && file.length() > 0L
      }
      phase = Phase.INTERRUPTED
      persistLocked(context)
      abandonFocusLocked(context)
      Log.w(TAG, "interrupted: $reason elapsed=$accumulatedMs finalized=$finalized")
    }
  }

  fun persistElapsed(context: Context) {
    synchronized(lock) {
      if (phase != Phase.RECORDING && phase != Phase.PAUSED) {
        return
      }
      persistLocked(context)
    }
  }

  fun reconcile(context: Context): Map<String, Any?> {
    val liveId = synchronized(lock) {
      if (serviceAlive && (phase == Phase.RECORDING || phase == Phase.PAUSED)) {
        activeId
      } else {
        null
      }
    }
    RecordingStore.markInterruptedIfOrphaned(context, liveId)
    if (liveId == null) {
      synchronized(lock) {
        if (!serviceAlive && (phase == Phase.RECORDING || phase == Phase.PAUSED)) {
          phase = Phase.INTERRUPTED
          pausedByTransientFocus = false
        }
        // Cold start: surface the newest interrupted file so the UI cannot
        // keep a previous process's "recording" flag.
        if (!serviceAlive && phase == Phase.IDLE && activeId == null) {
          val latest = RecordingStore.readAll(context).maxByOrNull { it.updatedAtMs }
          if (latest != null && latest.state == "interrupted") {
            activeId = latest.id
            activeFileName = latest.fileName
            startedAtMs = latest.startedAtMs
            accumulatedMs = latest.elapsedMs
            activePlayable = latest.playable
            activeCorrupt = latest.corrupt
            phase = Phase.INTERRUPTED
          }
        }
      }
    }
    return statusMap(context)
  }

  fun list(context: Context): List<Map<String, Any?>> {
    return RecordingStore.readAll(context)
      .sortedByDescending { it.startedAtMs }
      .map { meta ->
        val file = RecordingStore.fileFor(context, meta.fileName)
        val inProgress = meta.state == "recording" || meta.state == "paused"
        val nonempty = file.exists() && file.length() > 0L
        val playable = !inProgress &&
          nonempty &&
          !meta.corrupt &&
          mediaLooksPlayable(file)
        val corrupt = !inProgress && nonempty && !playable
        hashMapOf<String, Any?>(
          "id" to meta.id,
          "fileUri" to if (playable) RecordingStore.uriFor(context, meta.fileName) else null,
          "state" to meta.state,
          "elapsedMs" to meta.elapsedMs,
          "startedAtMs" to meta.startedAtMs,
          "updatedAtMs" to meta.updatedAtMs,
          "playable" to playable,
          "corrupt" to corrupt,
        )
      }
  }

  fun statusMap(context: Context): Map<String, Any?> {
    synchronized(lock) {
      val fileName = activeFileName
      val uri = if (fileName != null) {
        val file = RecordingStore.fileFor(context, fileName)
        if (file.exists()) RecordingStore.uriFor(context, fileName) else null
      } else {
        null
      }
      return hashMapOf<String, Any?>(
        "serviceAlive" to serviceAlive,
        "phase" to phase.wire,
        "sessionId" to activeId,
        "elapsedMs" to elapsedLocked(),
        "fileUri" to uri,
        "pausedByFocus" to pausedByTransientFocus,
        "lastError" to lastError,
      )
    }
  }

  fun emit(context: Context) {
    val snapshot = statusMap(context)
    onStatus?.invoke(snapshot)
  }

  /**
   * Waits until [op] settles. Success requires the target phase and no error.
   * A session that was already interrupted does not count as success.
   */
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

  private fun elapsedLocked(): Long {
    return if (phase == Phase.RECORDING) {
      accumulatedMs + (SystemClock.elapsedRealtime() - segmentStartedAt)
    } else {
      accumulatedMs
    }
  }

  private fun activeFile(context: Context): File? {
    val fileName = activeFileName ?: return null
    return RecordingStore.fileFor(context, fileName)
  }

  private fun persistLocked(context: Context) {
    val id = activeId ?: return
    val fileName = activeFileName ?: return
    RecordingStore.write(
      context,
      SessionMeta(
        id = id,
        state = phase.wire,
        elapsedMs = elapsedLocked(),
        startedAtMs = startedAtMs,
        updatedAtMs = System.currentTimeMillis(),
        fileName = fileName,
        playable = activePlayable,
        corrupt = activeCorrupt,
      ),
    )
  }

  /** True only when stop() returns. A thrown stop leaves an invalid MPEG-4 file. */
  private fun finalizeRecorderLocked(): Boolean {
    val current = recorder ?: return false
    recorder = null
    val stopped = try {
      current.stop()
      true
    } catch (error: RuntimeException) {
      Log.w(TAG, "MediaRecorder.stop failed", error)
      false
    }
    releaseQuietly(current)
    return stopped
  }

  private fun mediaLooksPlayable(file: File): Boolean {
    if (!file.exists() || file.length() <= 0L) {
      return false
    }
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(file.absolutePath)
      val duration = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toLongOrNull()
        ?: 0L
      val hasAudio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO)
      return duration > 0L && hasAudio != "no"
    } catch (error: Exception) {
      Log.w(TAG, "media validation failed for ${file.name}", error)
      return false
    } finally {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          retriever.close()
        } else {
          @Suppress("DEPRECATION")
          retriever.release()
        }
      } catch (error: Exception) {
        Log.w(TAG, "MediaMetadataRetriever release failed", error)
      }
    }
  }

  private fun createRecorder(context: Context): MediaRecorder {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      MediaRecorder(context)
    } else {
      @Suppress("DEPRECATION")
      MediaRecorder()
    }
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

  private fun releaseQuietly(current: MediaRecorder) {
    try {
      current.release()
    } catch (error: RuntimeException) {
      Log.w(TAG, "MediaRecorder.release failed", error)
    }
  }

  private fun deleteIfEmpty(file: File) {
    if (file.exists() && file.length() == 0L) {
      file.delete()
    }
  }
}

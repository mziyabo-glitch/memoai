package expo.modules.memoairecorder

import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
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

/**
 * In-process source of truth for the microphone capture. The foreground
 * service mutates it. The JS module only reads it.
 *
 * Elapsed time excludes pauses. It is computed here, not in JavaScript.
 */
internal object RecorderController {
  private const val TAG = "MemoAiRecorder"
  val lock = Any()

  @Volatile var phase: Phase = Phase.IDLE
  @Volatile var serviceAlive: Boolean = false
  @Volatile var lastError: String? = null

  var onStatus: ((Map<String, Any?>) -> Unit)? = null

  private var activeId: String? = null
  private var activeFileName: String? = null
  private var startedAtMs: Long = 0
  private var accumulatedMs: Long = 0
  private var segmentStartedAt: Long = 0
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

  fun prepareForCommand() {
    lastError = null
  }

  fun rejectStart(message: String) {
    synchronized(lock) {
      lastError = message
      serviceAlive = false
      if (phase != Phase.INTERRUPTED) {
        phase = Phase.IDLE
      }
    }
  }

  fun beginCapture(context: Context, sessionId: String, onFocusLost: () -> Unit): StartOutcome {
    synchronized(lock) {
      lastError = null
      val fileName = "$sessionId.m4a"
      val file = RecordingStore.fileFor(context, fileName)
      val created = createRecorder(context)
      var started = false
      startedAtMs = System.currentTimeMillis()
      accumulatedMs = 0
      try {
        created.setAudioSource(MediaRecorder.AudioSource.MIC)
        created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        created.setAudioEncodingBitRate(128_000)
        created.setAudioSamplingRate(44_100)
        created.setAudioChannels(1)
        created.setOutputFile(file.absolutePath)
        created.prepare()
        if (!requestAudioFocus(context, onFocusLost)) {
          created.release()
          deleteIfEmpty(file)
          lastError = "Audio focus was not granted"
          phase = Phase.IDLE
          serviceAlive = false
          return StartOutcome.REJECTED
        }
        // Microphone capture starts only after the service has called
        // startForeground. The service enforces that order.
        created.start()
        started = true
        created.setOnErrorListener { _, what, extra ->
          Log.w(TAG, "MediaRecorder error $what/$extra")
          onFocusLost()
        }
        recorder = created
        activeId = sessionId
        activeFileName = fileName
        segmentStartedAt = SystemClock.elapsedRealtime()
        phase = Phase.RECORDING
        serviceAlive = true
        persistLocked(context)
        Log.i(TAG, "capture started")
        return StartOutcome.RECORDING
      } catch (error: Exception) {
        Log.e(TAG, "capture failed", error)
        if (started) {
          try {
            created.stop()
          } catch (_: Exception) {
          }
        }
        try {
          created.release()
        } catch (_: Exception) {
        }
        recorder = null
        abandonFocusLocked(context)
        activeId = sessionId
        activeFileName = fileName
        if (startedAtMs == 0L) {
          startedAtMs = System.currentTimeMillis()
        }
        serviceAlive = false
        if (file.exists() && file.length() > 0L) {
          phase = Phase.INTERRUPTED
          persistLocked(context)
          lastError = error.message ?: "Microphone capture failed"
          return StartOutcome.INTERRUPTED
        }
        deleteIfEmpty(file)
        activeId = null
        activeFileName = null
        phase = Phase.IDLE
        lastError = error.message ?: "Microphone capture failed"
        return StartOutcome.REJECTED
      }
    }
  }

  fun pause(context: Context): Boolean {
    synchronized(lock) {
      if (phase != Phase.RECORDING || recorder == null) {
        lastError = "Nothing is recording"
        return false
      }
      accumulatedMs += SystemClock.elapsedRealtime() - segmentStartedAt
      recorder?.pause()
      phase = Phase.PAUSED
      serviceAlive = true
      persistLocked(context)
      Log.i(TAG, "paused at $accumulatedMs")
      return true
    }
  }

  fun resume(context: Context): Boolean {
    synchronized(lock) {
      if (phase != Phase.PAUSED || recorder == null) {
        lastError = "Nothing is paused"
        return false
      }
      recorder?.resume()
      segmentStartedAt = SystemClock.elapsedRealtime()
      phase = Phase.RECORDING
      serviceAlive = true
      persistLocked(context)
      Log.i(TAG, "resumed")
      return true
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
      finalizeRecorderLocked()
      phase = Phase.STOPPED
      serviceAlive = false
      persistLocked(context)
      abandonFocusLocked(context)
      Log.i(TAG, "stopped at $accumulatedMs")
      return true
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
      finalizeRecorderLocked()
      phase = Phase.INTERRUPTED
      serviceAlive = false
      persistLocked(context)
      abandonFocusLocked(context)
      Log.w(TAG, "interrupted: $reason elapsed=$accumulatedMs")
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
        val playable = file.exists() && file.length() > 0L
        hashMapOf<String, Any?>(
          "id" to meta.id,
          "fileUri" to if (playable) RecordingStore.uriFor(context, meta.fileName) else null,
          "state" to meta.state,
          "elapsedMs" to meta.elapsedMs,
          "startedAtMs" to meta.startedAtMs,
          "updatedAtMs" to meta.updatedAtMs,
          "playable" to playable,
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
      )
    }
  }

  fun emit(context: Context) {
    val snapshot = statusMap(context)
    onStatus?.invoke(snapshot)
  }

  fun awaitPhase(context: Context, target: Phase, timeoutMs: Long): Map<String, Any?> {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      val current = phase
      if (current == target && (target != Phase.RECORDING || serviceAlive)) {
        return statusMap(context)
      }
      if (current == Phase.INTERRUPTED && target != Phase.INTERRUPTED) {
        return statusMap(context)
      }
      val error = lastError
      if (error != null && current != target) {
        throw RecorderException(error)
      }
      Thread.sleep(20)
    }
    if (phase == target && (target != Phase.RECORDING || serviceAlive)) {
      return statusMap(context)
    }
    if (phase == Phase.INTERRUPTED) {
      return statusMap(context)
    }
    throw RecorderException(lastError ?: "The recording service did not respond")
  }

  private fun elapsedLocked(): Long {
    return if (phase == Phase.RECORDING) {
      accumulatedMs + (SystemClock.elapsedRealtime() - segmentStartedAt)
    } else {
      accumulatedMs
    }
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
      ),
    )
  }

  private fun finalizeRecorderLocked() {
    val current = recorder ?: return
    recorder = null
    try {
      current.stop()
    } catch (error: RuntimeException) {
      Log.w(TAG, "MediaRecorder.stop failed", error)
    }
    try {
      current.release()
    } catch (error: RuntimeException) {
      Log.w(TAG, "MediaRecorder.release failed", error)
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

  private fun requestAudioFocus(context: Context, onFocusLost: () -> Unit): Boolean {
    val manager = context.getSystemService(AudioManager::class.java) ?: return false
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      if (
        change == AudioManager.AUDIOFOCUS_LOSS ||
        change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
      ) {
        onFocusLost()
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

  private fun deleteIfEmpty(file: File) {
    if (file.exists() && file.length() == 0L) {
      file.delete()
    }
  }
}

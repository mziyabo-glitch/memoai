package expo.modules.memoairecorder

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

internal class AndroidAudioPart(
  context: Context,
  file: File,
  onLimit: () -> Unit,
  onError: () -> Unit,
) : AudioPart {
  private val recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else {
    @Suppress("DEPRECATION") MediaRecorder()
  }
  override var limitReached = false
    private set
  private var released = false

  init {
    try {
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      recorder.setAudioEncodingBitRate(128_000)
      recorder.setAudioSamplingRate(44_100)
      recorder.setAudioChannels(1)
      recorder.setMaxDuration(45_000)
      // Leave headroom for the container; commit also enforces the actual 20 MiB limit.
      recorder.setMaxFileSize(19L * 1024 * 1024)
      recorder.setOutputFile(file.absolutePath)
      recorder.setOnInfoListener { _, what, _ ->
        if (!released && (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED ||
            what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)) {
          limitReached = true
          onLimit()
        }
      }
      recorder.setOnErrorListener { _, _, _ -> if (!released) onError() }
      recorder.prepare()
    } catch (error: Exception) {
      release()
      throw error
    }
  }

  override fun start() = recorder.start()
  override fun pause() = recorder.pause()
  override fun resume() = recorder.resume()
  override fun finish() {
    try { recorder.stop() } catch (error: RuntimeException) {
      // Android may already have stopped at its native duration limit. The journal
      // still requires a demuxable audio sample and duration before committing it.
      if (!limitReached) throw error
    }
  }
  override fun release() {
    if (!released) {
      released = true
      recorder.release()
    }
  }
}

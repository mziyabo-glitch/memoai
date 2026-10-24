package expo.modules.memoairecorder

import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.nio.ByteBuffer
import java.util.UUID

internal data class AudioSegment(
  val id: String,
  val sequence: Int,
  val fileName: String,
  val durationMs: Long = 0,
  val sizeBytes: Long = 0,
  val sha256: String = "",
  val complete: Boolean = false,
)

internal data class SegmentSession(
  val id: String,
  val startedAtMs: Long,
  val state: String = "recording",
  val segments: List<AudioSegment> = emptyList(),
  val rotationGapMs: Long = 0,
) {
  val durationMs: Long get() = segments.filter { it.complete }.sumOf { it.durationMs }
}

/** One authoritative journal per session. Caller holds RecorderController.lock. */
internal class SegmentJournal(
  val directory: File,
  private val probe: (File) -> Long? = ::audioDuration,
  private val checkpoint: (String) -> Unit = {},
) {
  companion object {
    const val MAX_BYTES = 20L * 1024 * 1024

    fun audioDuration(file: File): Long? {
      if (!file.isFile || file.length() == 0L) return null
      val extractor = MediaExtractor()
      return try {
        extractor.setDataSource(file.absolutePath)
        val track = (0 until extractor.trackCount).firstOrNull {
          extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        } ?: return null
        val duration = extractor.getTrackFormat(track).getLong(MediaFormat.KEY_DURATION) / 1000
        extractor.selectTrack(track)
        if (duration > 0 && extractor.readSampleData(ByteBuffer.allocate(256 * 1024), 0) > 0) duration else null
      } catch (_: Exception) { null } finally { extractor.release() }
    }
  }

  fun file(name: String): File {
    require(name.isNotBlank() && name != "." && name != ".." &&
      !name.contains('/') && !name.contains('\\'))
    return File(directory, name)
  }

  fun write(session: SegmentSession) {
    directory.mkdirs()
    val parts = JSONArray()
    session.segments.forEach { part ->
      parts.put(JSONObject().put("id", part.id).put("sequence", part.sequence)
        .put("fileName", part.fileName).put("durationMs", part.durationMs)
        .put("sizeBytes", part.sizeBytes).put("sha256", part.sha256).put("complete", part.complete))
    }
    val json = JSONObject().put("version", 2).put("id", session.id)
      .put("startedAtMs", session.startedAtMs).put("state", session.state)
      .put("rotationGapMs", session.rotationGapMs).put("segments", parts)
    val target = AtomicFile(file("${session.id}.journal.json"))
    val stream = target.startWrite()
    try {
      stream.write(json.toString().toByteArray(Charsets.UTF_8))
      stream.fd.sync()
      target.finishWrite(stream)
    } catch (error: Throwable) {
      target.failWrite(stream)
      throw error
    }
  }

  fun readAll(): List<SegmentSession> = (directory.listFiles() ?: emptyArray())
    .filter { it.name.endsWith(".journal.json") || it.name.endsWith(".journal.json.bak") }
    .map { it.name.removeSuffix(".bak") }.distinct().mapNotNull { name ->
      try {
        val json = AtomicFile(file(name)).openRead().bufferedReader().use { JSONObject(it.readText()) }
        require(json.getInt("version") == 2)
        val id = json.getString("id")
        require(name == "$id.journal.json")
        val array = json.getJSONArray("segments")
        val segments = (0 until array.length()).map { i ->
          val part = array.getJSONObject(i)
          val partId = part.getString("id")
          val sequence = part.getInt("sequence")
          val fileName = part.getString("fileName")
          require(sequence == i && fileName == "$id.$sequence.$partId.m4a")
          file(fileName)
          AudioSegment(partId, sequence, fileName, part.getLong("durationMs"),
            part.getLong("sizeBytes"), part.getString("sha256"), part.getBoolean("complete"))
        }
        SegmentSession(id, json.getLong("startedAtMs"), json.getString("state"),
          segments, json.optLong("rotationGapMs", 0))
      } catch (_: Exception) { null }
    }

  fun beginPart(session: SegmentSession): SegmentSession {
    val uuid = UUID.randomUUID().toString()
    val index = session.segments.size
    val part = AudioSegment(uuid, index, "${session.id}.$index.$uuid.m4a")
    val next = session.copy(segments = session.segments + part)
    write(next) // Intent reaches disk before any microphone bytes.
    checkpoint("intent")
    return next
  }

  fun commitPart(session: SegmentSession, index: Int): SegmentSession {
    val part = session.segments[index]
    val target = file(part.fileName)
    val partial = file(part.fileName + ".partial")
    val source = if (target.exists()) target else partial
    require(source.length() in 1..MAX_BYTES) { "Audio part is empty or exceeds 20 MiB; file retained" }
    val duration = probe(source) ?: throw IllegalStateException("Audio part is incomplete; file retained")
    RandomAccessFile(source, "rw").use { it.fd.sync() }
    checkpoint("synced")
    if (source == partial) check(partial.renameTo(target)) { "Could not finalize audio part; file retained" }
    checkpoint("renamed")
    val complete = part.copy(durationMs = duration, sizeBytes = target.length(), sha256 = hash(target), complete = true)
    val next = session.copy(segments = session.segments.mapIndexed { i, item -> if (i == index) complete else item })
    checkpoint("beforeJournal")
    write(next)
    checkpoint("committed")
    return next
  }

  fun reconcile(session: SegmentSession): SegmentSession {
    var next = session
    session.segments.forEachIndexed { index, part ->
      if (part.complete) {
        val target = file(part.fileName)
        val valid = target.isFile && target.length() == part.sizeBytes &&
          target.length() <= MAX_BYTES && hash(target) == part.sha256 && probe(target) != null
        if (!valid) next = next.copy(segments = next.segments.mapIndexed { i, item ->
          if (i == index) item.copy(complete = false) else item
        })
      } else if (part.sha256.isEmpty()) {
        // Adopt a finalized part after a crash before journal commit. Never re-trust a changed hash.
        try { next = commitPart(next, index) } catch (_: Exception) { /* Retain incomplete bytes. */ }
      }
    }
    if (next.state == "recording" || next.state == "paused" || next.segments.any { !it.complete }) {
      next = next.copy(state = "interrupted")
    }
    if (next != session) write(next)
    return next
  }

  private fun hash(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      var count = input.read(buffer)
      while (count >= 0) {
        if (count > 0) digest.update(buffer, 0, count)
        count = input.read(buffer)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}

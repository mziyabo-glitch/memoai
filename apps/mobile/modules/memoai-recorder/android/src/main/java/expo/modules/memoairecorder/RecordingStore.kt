package expo.modules.memoairecorder

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File

internal data class SessionMeta(
  val id: String,
  val state: String,
  val elapsedMs: Long,
  val startedAtMs: Long,
  val updatedAtMs: Long,
  val fileName: String,
)

/**
 * Session metadata sits beside the audio file in app-specific storage.
 * Nothing here is deleted when a capture is interrupted.
 */
internal object RecordingStore {
  fun directory(context: Context): File {
    return File(context.filesDir, "recordings").apply { mkdirs() }
  }

  fun fileFor(context: Context, fileName: String): File {
    return File(directory(context), fileName)
  }

  fun uriFor(context: Context, fileName: String): String {
    return Uri.fromFile(fileFor(context, fileName)).toString()
  }

  fun write(context: Context, meta: SessionMeta) {
    val dir = directory(context)
    val json = toJson(meta).toString()
    val target = File(dir, "${meta.id}.json")
    val tmp = File(dir, "${meta.id}.json.tmp")
    tmp.writeText(json)
    if (!tmp.renameTo(target)) {
      target.writeText(json)
      tmp.delete()
    }
  }

  fun readAll(context: Context): List<SessionMeta> {
    val files = directory(context).listFiles { file ->
      file.isFile && file.name.endsWith(".json") && !file.name.endsWith(".tmp")
    } ?: return emptyList()
    return files.mapNotNull { file ->
      try {
        fromJson(JSONObject(file.readText()))
      } catch (_: Exception) {
        null
      }
    }
  }

  /**
   * A metadata file that still says recording or paused, while that session
   * is not the live service, is a partial file from a dead process.
   */
  fun markInterruptedIfOrphaned(context: Context, liveSessionId: String?) {
    val now = System.currentTimeMillis()
    for (meta in readAll(context)) {
      val live = liveSessionId != null && meta.id == liveSessionId
      if (!live && (meta.state == "recording" || meta.state == "paused")) {
        write(context, meta.copy(state = "interrupted", updatedAtMs = now))
      }
    }
  }

  private fun toJson(meta: SessionMeta): JSONObject {
    return JSONObject()
      .put("id", meta.id)
      .put("state", meta.state)
      .put("elapsedMs", meta.elapsedMs)
      .put("startedAtMs", meta.startedAtMs)
      .put("updatedAtMs", meta.updatedAtMs)
      .put("fileName", meta.fileName)
  }

  private fun fromJson(json: JSONObject): SessionMeta {
    return SessionMeta(
      id = json.getString("id"),
      state = json.getString("state"),
      elapsedMs = json.getLong("elapsedMs"),
      startedAtMs = json.getLong("startedAtMs"),
      updatedAtMs = json.getLong("updatedAtMs"),
      fileName = json.getString("fileName"),
    )
  }
}

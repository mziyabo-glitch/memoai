package expo.modules.memoairecorder

import android.content.Context
import android.content.Intent
import android.content.ClipData
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

internal object RecoveryFiles {
  // Called under the controller lock. Never touch a live recording or its journal.
  fun files(context: Context): List<File> {
    if (RecorderController.serviceAlive) return emptyList()
    val directory = RecordingStore.directory(context)
    val known = mutableSetOf<String>()
    RecordingStore.readAll(context).forEach {
      known.add("${it.id}.json")
      if (!it.corrupt && SegmentJournal.audioDuration(RecordingStore.fileFor(context, it.fileName)) != null) {
        known.add(it.fileName)
      }
    }
    SegmentJournal(directory).readAll().forEach { session ->
      known.add("${session.id}.journal.json")
      session.segments.filter { it.complete }.forEach { known.add(it.fileName) }
    }
    return (directory.listFiles() ?: emptyArray()).filter { it.isFile && it.name !in known }
      .sortedBy { it.name }
  }

  fun list(context: Context): List<Map<String, Any?>> = files(context).map {
    mapOf("name" to it.name, "sizeBytes" to it.length(), "canRecover" to
      (it.name.endsWith(".m4a") || it.name.endsWith(".partial")))
  }

  fun requireFile(context: Context, name: String): File = files(context).firstOrNull { it.name == name }
    ?: throw RecorderException("This recovery file is no longer available, or recording is active")

  fun recover(context: Context, name: String) {
    val file = requireFile(context, name)
    // Journal-owned pending files can only be adopted through journal reconciliation.
    val store = SegmentJournal(RecordingStore.directory(context))
    val owner = store.readAll().firstOrNull { session ->
      session.segments.any { it.fileName == name || it.fileName + ".partial" == name }
    }
    if (owner != null) {
      val updated = store.reconcile(owner)
      if (updated.segments.none { it.complete && (it.fileName == name || it.fileName + ".partial" == name) }) {
        throw RecorderException("This audio section cannot be recovered. You can export the original file.")
      }
      return
    }
    val duration = SegmentJournal.audioDuration(file)
      ?: throw RecorderException("This file has no readable audio. It has been kept for export.")
    // Add an index without rewriting or deleting legacy/orphan audio or damaged metadata.
    val id = UUID.randomUUID().toString()
    RecordingStore.write(context, SessionMeta(id, "interrupted", duration, file.lastModified(),
      System.currentTimeMillis(), name, true, false))
  }

  fun export(context: Context, name: String) {
    val file = requireFile(context, name)
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.memoai.recovery", file)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = "application/octet-stream"
      putExtra(Intent.EXTRA_STREAM, uri)
      clipData = ClipData.newRawUri("MemoAI recovery file", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, "Export recovery file").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}

package expo.modules.memoairecorder

import android.content.Context
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SegmentRecoveryTest {
  private lateinit var context: Context
  private lateinit var directory: File
  private val validBytes = "finalized test audio"
  private val probe: (File) -> Long? = { if (it.readText() == validBytes) 45_000L else null }
  private val initial = SegmentSession("session", 100)

  @Before fun setup() {
    context = RuntimeEnvironment.getApplication()
    directory = RecordingStore.directory(context)
    directory.deleteRecursively()
    directory.mkdirs()
  }

  private fun crashAt(stage: String) {
    val store = SegmentJournal(directory, probe)
    val pending = store.beginPart(initial)
    store.file(pending.segments[0].fileName + ".partial").writeText(validBytes)
    val crashing = SegmentJournal(directory, probe) { if (it == stage) throw IOException("simulated process death") }
    try { crashing.commitPart(pending, 0); fail("Expected injected failure") } catch (_: IOException) {}
    val recovered = store.reconcile(store.readAll().single())
    assertEquals("interrupted", recovered.state)
    assertTrue(recovered.segments.single().complete)
    assertEquals(45_000L, recovered.durationMs)
    assertEquals(64, recovered.segments.single().sha256.length)
    val journalBytes = store.file("session.journal.json").readBytes()
    assertEquals(recovered, store.reconcile(recovered))
    assertArrayEquals(journalBytes, store.file("session.journal.json").readBytes())
  }

  @Test fun crashAfterSyncRecovers() = crashAt("synced")
  @Test fun crashAfterRenameRecovers() = crashAt("renamed")
  @Test fun crashBeforeJournalRecovers() = crashAt("beforeJournal")
  @Test fun crashAfterCommitRecovers() = crashAt("committed")

  @Test fun crashAfterIntentKeepsMissingPartInterrupted() {
    val store = SegmentJournal(directory, probe)
    val pending = store.beginPart(initial)
    val recovered = store.reconcile(pending)
    assertEquals("interrupted", recovered.state)
    assertFalse(recovered.segments.single().complete)
    assertEquals(recovered, store.reconcile(recovered))
  }

  @Test fun invalidPartialIsPreservedWithoutClaimingRecovery() {
    val store = SegmentJournal(directory, probe)
    val pending = store.beginPart(initial)
    val partial = store.file(pending.segments[0].fileName + ".partial")
    partial.writeText("unfinished")
    val recovered = store.reconcile(pending)
    assertFalse(recovered.segments.single().complete)
    assertEquals("unfinished", partial.readText())
  }

  @Test fun changedCommittedAudioIsNeverSilentlyTrustedAgain() {
    var duration = 45_000L
    val store = SegmentJournal(directory, { duration })
    val pending = store.beginPart(initial)
    store.file(pending.segments[0].fileName + ".partial").writeText("aa")
    val complete = store.commitPart(pending, 0)
    store.file(complete.segments[0].fileName).writeText("bb")
    duration = 40_000L
    val recovered = store.reconcile(complete)
    assertFalse(recovered.segments[0].complete)
    assertFalse(store.reconcile(recovered).segments[0].complete)
  }

  @Test fun oversizePartIsKeptButNotCommitted() {
    val store = SegmentJournal(directory, { 1L })
    val pending = store.beginPart(initial)
    val partial = store.file(pending.segments[0].fileName + ".partial")
    java.io.RandomAccessFile(partial, "rw").use { it.setLength(SegmentJournal.MAX_BYTES + 1) }
    assertFalse(store.reconcile(pending).segments[0].complete)
    assertTrue(partial.exists())
  }

  @Test fun malformedJournalAndOrphanRemainVisibleForExport() {
    File(directory, "broken.journal.json").writeText("{broken")
    File(directory, "orphan.m4a").writeText("unfinished")
    assertTrue(SegmentJournal(directory, probe).readAll().isEmpty())
    assertTrue(RecoveryFiles.files(context).map { it.name }.containsAll(listOf("broken.journal.json", "orphan.m4a")))
  }

  @Test fun oldRecordingsRemainIndexedWithoutMigrationOrDeletion() {
    val audio = File(directory, "old.m4a").apply { writeText(validBytes) }
    RecordingStore.write(context, SessionMeta("old", "stopped", 500, 1, 2, audio.name, true, false))
    val before = File(directory, "old.json").readBytes()
    val store = SegmentJournal(directory, probe)
    store.write(initial)
    store.reconcile(initial)
    assertEquals("old", RecordingStore.readAll(context).single().id)
    assertArrayEquals(before, File(directory, "old.json").readBytes())
    assertEquals(validBytes, audio.readText())
  }

  private inner class FakePart(val output: File) : AudioPart {
    override var limitReached = false
    var pauses = 0
    var resumes = 0
    var finishes = 0
    override fun start() { output.writeText("unfinished") }
    override fun pause() { pauses++ }
    override fun resume() { resumes++ }
    override fun finish() { finishes++; output.writeText(validBytes) }
    override fun release() {}
  }

  private fun engine(parts: MutableList<FakePart>, checkpoint: (String) -> Unit = {}): SegmentCapture {
    var clock = 0L
    return SegmentCapture(SegmentJournal(directory, probe, checkpoint), initial, { file ->
      assertTrue(File(directory, "session.journal.json").readText().contains(file.name.removeSuffix(".partial")))
      FakePart(file).also { parts.add(it) }
    }, { clock += 10; clock })
  }

  @Test fun stopBeforeQueuedRotationNeverRestartsCapture() {
    val parts = mutableListOf<FakePart>()
    val engine = engine(parts)
    engine.start()
    parts[0].limitReached = true
    engine.stop()
    assertFalse(engine.rotate())
    engine.stop()
    assertEquals(1, parts.size)
    assertEquals(1, parts[0].finishes)
    assertEquals(45_000L, engine.session.durationMs)
  }

  @Test fun rotationBeforeStopKeepsBothPartsInOrder() {
    val parts = mutableListOf<FakePart>()
    val engine = engine(parts)
    engine.start()
    parts[0].limitReached = true
    assertTrue(engine.rotate())
    assertFalse(engine.rotate()) // Duplicate event cannot rotate a fresh part.
    engine.stop()
    assertEquals(listOf(0, 1), engine.session.segments.map { it.sequence })
    assertTrue(engine.session.segments.all { it.complete })
    assertEquals(90_000L, engine.session.durationMs)
    assertEquals(10L, engine.session.rotationGapMs)
  }

  @Test fun pauseAtBoundaryDoesNotStartAnotherPartUntilResume() {
    val parts = mutableListOf<FakePart>()
    val engine = engine(parts)
    engine.start()
    parts[0].limitReached = true
    engine.pause()
    assertFalse(engine.rotate())
    assertEquals(1, parts.size)
    engine.resume()
    assertEquals(2, parts.size)
    engine.stop()
  }

  @Test fun ordinaryPauseResumeKeepsTheSamePart() {
    val parts = mutableListOf<FakePart>()
    val engine = engine(parts)
    engine.start()
    engine.pause()
    engine.pause()
    engine.resume()
    engine.stop()
    assertEquals(1, parts.size)
    assertEquals(1, parts[0].pauses)
    assertEquals(1, parts[0].resumes)
  }

  @Test fun diskFailureBeforeIntentNeverOpensMicrophone() {
    val parts = mutableListOf<FakePart>()
    val engine = engine(parts) { if (it == "intent") throw IOException("disk full") }
    try { engine.start(); fail("Expected storage failure") } catch (_: IOException) {}
    assertTrue(parts.isEmpty())
    assertEquals(1, SegmentJournal(directory, probe).readAll().single().segments.size)
  }

  @Test fun commitFailureKeepsEarlierSectionAndDoesNotStartNext() {
    val parts = mutableListOf<FakePart>()
    var failWrites = false
    val engine = engine(parts) { if (failWrites && it == "beforeJournal") throw IOException("disk full") }
    engine.start()
    parts[0].limitReached = true
    engine.rotate()
    failWrites = true
    parts[1].limitReached = true
    try { engine.rotate(); fail("Expected storage failure") } catch (_: IOException) {}
    engine.stop()
    assertEquals(2, parts.size)
    val store = SegmentJournal(directory, probe)
    assertEquals(90_000L, store.reconcile(store.readAll().single()).durationMs)
  }

  @Test fun journalRejectsPathTraversalAndPreservesDamagedMetadata() {
    val store = SegmentJournal(directory, probe)
    val session = store.beginPart(initial)
    val target = File(directory, "session.journal.json")
    target.writeText(target.readText().replace(session.segments[0].fileName, "../outside.m4a"))
    assertTrue(store.readAll().isEmpty())
    assertTrue(target.exists())
  }
}

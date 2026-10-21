package expo.modules.memoairecorder

import android.content.Context
import android.util.AtomicFile
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecordingStoreTest {
  private lateinit var context: Context
  private val original = SessionMeta("session", "recording", 10L, 1L, 2L, "session.m4a", false, false)

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    RecordingStore.directory(context).deleteRecursively()
  }

  @Test
  fun interruptedReplacementKeepsCommittedMetadata() {
    RecordingStore.write(context, original)
    val target = File(RecordingStore.directory(context), "session.json")
    // Close the unfinished stream without finishWrite/failWrite, as at process death.
    AtomicFile(target).startWrite().use { it.write("{partial".toByteArray()) }
    assertEquals(listOf(original), RecordingStore.readAll(context))
    assertEquals(listOf(original), RecordingStore.readAll(context))
  }

  @Test
  fun backupOnlyRecordIsRestoredOnce() {
    RecordingStore.write(context, original)
    val target = File(RecordingStore.directory(context), "session.json")
    assertTrue(target.renameTo(File(target.path + ".bak")))
    assertEquals(listOf(original), RecordingStore.readAll(context))
    assertEquals(listOf(original), RecordingStore.readAll(context))
    assertTrue(target.exists())
  }

  @Test
  fun legacyJsonAndAudioArePreserved() {
    val dir = RecordingStore.directory(context)
    val audio = File(dir, original.fileName).apply { writeText("audio fixture") }
    val legacy = File(dir, "session.json").apply {
      writeText("""{"id":"session","state":"stopped","elapsedMs":10,"startedAtMs":1,"updatedAtMs":2,"fileName":"session.m4a"}""")
    }
    val before = legacy.readText()
    assertTrue(RecordingStore.readAll(context).single().playable)
    assertEquals(before, legacy.readText())
    assertEquals("audio fixture", audio.readText())
  }

  @Test
  fun corruptMetadataAndOldTemporaryFilesAreKept() {
    val dir = RecordingStore.directory(context)
    val corrupt = File(dir, "broken.json").apply { writeText("{broken") }
    val oldTemp = File(dir, "session.json.tmp").apply { writeText("{partial") }
    RecordingStore.write(context, original)
    assertEquals(listOf(original), RecordingStore.readAll(context))
    assertEquals("{broken", corrupt.readText())
    assertEquals("{partial", oldTemp.readText())
  }

  @Test
  fun concurrentReadersAndWritersNeverObservePartialJson() {
    RecordingStore.write(context, original)
    val pool = Executors.newFixedThreadPool(4)
    try {
      val futures = (1..40).map { index ->
        pool.submit {
          RecordingStore.write(context, original.copy(elapsedMs = index.toLong()))
          assertEquals("session", RecordingStore.readAll(context).single().id)
        }
      }
      futures.forEach { it.get(10, TimeUnit.SECONDS) }
    } finally {
      pool.shutdownNow()
    }
  }

  @Test
  fun orphanReconciliationIsIdempotent() {
    RecordingStore.write(context, original)
    RecordingStore.markInterruptedIfOrphaned(context, null)
    val interrupted = RecordingStore.readAll(context).single()
    assertEquals("interrupted", interrupted.state)
    assertFalse(interrupted.playable)
    RecordingStore.markInterruptedIfOrphaned(context, null)
    assertEquals(listOf(interrupted), RecordingStore.readAll(context))
  }
}

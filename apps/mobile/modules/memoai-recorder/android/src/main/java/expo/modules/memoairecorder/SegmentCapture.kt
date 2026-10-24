package expo.modules.memoairecorder

import java.io.File

internal interface AudioPart {
  val limitReached: Boolean
  fun start()
  fun pause()
  fun resume()
  fun finish()
  fun release()
}

/** Caller serializes every operation with RecorderController.lock. */
internal class SegmentCapture(
  private val journal: SegmentJournal,
  initial: SegmentSession,
  private val create: (File) -> AudioPart,
  private val now: () -> Long,
) {
  var session = initial
    private set
  private var current: AudioPart? = null
  private var stopped = false
  private var paused = false

  fun start() {
    check(current == null && !stopped)
    check(!journal.file("${session.id}.journal.json").exists()) { "This recording session already exists" }
    journal.write(session)
    startPart()
  }

  private fun startPart() {
    session = journal.beginPart(session)
    val part = create(journal.file(session.segments.last().fileName + ".partial"))
    current = part
    part.start()
  }

  fun pause() {
    check(!stopped)
    if (!paused) {
      if (current?.limitReached == true) finishPart() else current?.pause()
      paused = true
    }
  }

  fun resume() {
    check(!stopped)
    if (current?.limitReached == true) finishPart()
    if (current == null) startPart() else current!!.resume()
    paused = false
  }

  fun rotate(): Boolean {
    if (stopped || current?.limitReached != true) return false
    val boundaryAt = now()
    finishPart()
    if (!paused) startPart()
    session = session.copy(rotationGapMs = session.rotationGapMs + (now() - boundaryAt).coerceAtLeast(0))
    journal.write(session)
    return true
  }

  fun stop() {
    if (stopped) return
    stopped = true
    finishPart()
  }

  private fun finishPart() {
    val part = current ?: return
    current = null
    try { part.finish() } finally { part.release() }
    session = journal.commitPart(session, session.segments.lastIndex)
  }

  fun persist(state: String) {
    session = session.copy(state = state)
    journal.write(session)
  }

  fun release() {
    stopped = true
    current?.release()
    current = null
  }
}

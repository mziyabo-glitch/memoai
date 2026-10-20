import { describe, expect, it } from "vitest";
import {
  SESSION_STATES,
  formatDuration,
  isRecordingLabelAllowed,
  parseSessionState,
  projectVisibleState,
  recordingElapsedMs,
  reduceSession,
  type ServicePhase,
  type ServiceSnapshot,
  type SessionState,
} from "./session";

const service = (
  alive: boolean,
  phase: ServicePhase,
  elapsedMs = 10,
): ServiceSnapshot => ({ alive, phase, elapsedMs });

describe("reduceSession", () => {
  it("starts only from an idle-like state in the foreground when the service accepts", () => {
    for (const state of ["idle", "stopped", "interrupted"] as const) {
      expect(
        reduceSession(state, {
          type: "start",
          appInForeground: true,
          serviceAccepted: true,
        }),
      ).toEqual({ state: "recording", accepted: true });
    }
  });

  it("rejects start while backgrounded and does not enter recording", () => {
    expect(
      reduceSession("idle", {
        type: "start",
        appInForeground: false,
        serviceAccepted: true,
      }),
    ).toEqual({ state: "idle", accepted: false, reason: "backgrounded" });
  });

  it("rejects start when the service does not accept", () => {
    expect(
      reduceSession("idle", {
        type: "start",
        appInForeground: true,
        serviceAccepted: false,
      }),
    ).toEqual({ state: "idle", accepted: false, reason: "service-rejected" });
  });

  it("pauses and resumes only with service acceptance", () => {
    expect(
      reduceSession("recording", { type: "pause", serviceAccepted: true }),
    ).toEqual({ state: "paused", accepted: true });
    expect(
      reduceSession("paused", {
        type: "resume",
        appInForeground: true,
        serviceAccepted: true,
      }),
    ).toEqual({ state: "recording", accepted: true });
    expect(
      reduceSession("paused", {
        type: "resume",
        appInForeground: false,
        serviceAccepted: true,
      }),
    ).toEqual({ state: "paused", accepted: false, reason: "backgrounded" });
    expect(
      reduceSession("recording", { type: "pause", serviceAccepted: false }),
    ).toEqual({
      state: "recording",
      accepted: false,
      reason: "service-rejected",
    });
  });

  it("stops from recording or paused and ignores idle", () => {
    expect(
      reduceSession("recording", { type: "stop", serviceAccepted: true }),
    ).toEqual({ state: "stopped", accepted: true });
    expect(
      reduceSession("paused", { type: "stop", serviceAccepted: true }),
    ).toEqual({ state: "stopped", accepted: true });
    expect(
      reduceSession("idle", { type: "stop", serviceAccepted: true }),
    ).toEqual({ state: "idle", accepted: false, reason: "not-active" });
  });

  it("moves an active session to interrupted when the service ends", () => {
    expect(reduceSession("recording", { type: "serviceEnded" })).toEqual({
      state: "interrupted",
      accepted: true,
    });
    expect(reduceSession("paused", { type: "serviceEnded" })).toEqual({
      state: "interrupted",
      accepted: true,
    });
    expect(reduceSession("idle", { type: "serviceEnded" })).toEqual({
      state: "idle",
      accepted: false,
      reason: "not-active",
    });
  });

  it("recovers a dead recording or paused session as interrupted on launch", () => {
    expect(
      reduceSession("recording", { type: "launch", serviceAlive: false }),
    ).toEqual({ state: "interrupted", accepted: true });
    expect(
      reduceSession("paused", { type: "launch", serviceAlive: false }),
    ).toEqual({ state: "interrupted", accepted: true });
    expect(
      reduceSession("recording", { type: "launch", serviceAlive: true }),
    ).toEqual({ state: "recording", accepted: true });
    expect(
      reduceSession("stopped", { type: "launch", serviceAlive: false }),
    ).toEqual({ state: "stopped", accepted: true });
  });
});

describe("projectVisibleState", () => {
  it("shows recording only when the service confirms it right now", () => {
    const phases: ServicePhase[] = ["idle", "recording", "paused"];
    for (const state of SESSION_STATES) {
      for (const alive of [true, false]) {
        for (const phase of phases) {
          const live = service(alive, phase, 40);
          const visible = projectVisibleState(
            { state, elapsedMs: 15 },
            live,
          );
          if (visible.showRecording) {
            expect(live.alive).toBe(true);
            expect(live.phase).toBe("recording");
            expect(visible.state).toBe("recording");
          }
          expect(visible.showRecording).toBe(
            isRecordingLabelAllowed(visible, live),
          );
        }
      }
    }
  });

  it("does not keep a recording label after the service dies", () => {
    for (const state of ["recording", "paused"] as const) {
      const visible = projectVisibleState(
        { state, elapsedMs: 90_000 },
        service(false, "recording", 90_000),
      );
      expect(visible.state).toBe("interrupted");
      expect(visible.showRecording).toBe(false);
      expect(visible.elapsedMs).toBe(90_000);
    }
  });

  it("follows a live paused service instead of a stale recording flag", () => {
    const visible = projectVisibleState(
      { state: "recording", elapsedMs: 1 },
      service(true, "paused", 4_000),
    );
    expect(visible.state).toBe("paused");
    expect(visible.showRecording).toBe(false);
    expect(visible.elapsedMs).toBe(4_000);
  });

  it("uses the service clock while recording", () => {
    const visible = projectVisibleState(
      { state: "idle", elapsedMs: 0 },
      service(true, "recording", 12_000),
    );
    expect(visible).toEqual({
      state: "recording",
      elapsedMs: 12_000,
      showRecording: true,
    });
  });
});

describe("recordingElapsedMs", () => {
  it("excludes time spent paused", () => {
    const accumulated = recordingElapsedMs({
      accumulatedMs: 0,
      segmentStartedAtElapsedMs: 1_000,
      nowElapsedMs: 6_000,
      running: true,
    });
    expect(accumulated).toBe(5_000);
    expect(
      recordingElapsedMs({
        accumulatedMs: accumulated,
        segmentStartedAtElapsedMs: null,
        nowElapsedMs: 10_000,
        running: false,
      }),
    ).toBe(5_000);
    expect(
      recordingElapsedMs({
        accumulatedMs: accumulated,
        segmentStartedAtElapsedMs: 10_000,
        nowElapsedMs: 12_500,
        running: true,
      }),
    ).toBe(7_500);
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(1_000)).toBe("00:01");
    expect(formatDuration(61_000)).toBe("01:01");
    expect(formatDuration(3_600_000)).toBe("01:00:00");
    expect(formatDuration(-50)).toBe("00:00");
  });
});

describe("parseSessionState", () => {
  it("falls back to interrupted for unknown values", () => {
    const known: SessionState = parseSessionState("paused");
    expect(known).toBe("paused");
    expect(parseSessionState("still-going")).toBe("interrupted");
  });
});

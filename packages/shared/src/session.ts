/**
 * Session state for a personal meeting recording.
 *
 * "recording" is a confirmed fact about the native foreground service.
 * Callers may display that word only when `showRecording` is true.
 */

export const SESSION_STATES = [
  "idle",
  "recording",
  "paused",
  "interrupted",
  "stopped",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export type ServicePhase = "idle" | "recording" | "paused";

/** Live report from the microphone foreground service. */
export interface ServiceSnapshot {
  /** True only while that service process is running. */
  alive: boolean;
  /** Ignored for the recording label unless `alive` is true. */
  phase: ServicePhase;
  /** Elapsed capture time owned by the service, excluding paused time. */
  elapsedMs: number;
}

export interface SessionSnapshot {
  state: SessionState;
  elapsedMs: number;
}

export interface VisibleSession extends SessionSnapshot {
  /** The only signal that may render a "recording" label. */
  showRecording: boolean;
}

export function parseSessionState(value: string): SessionState {
  switch (value) {
    case "idle":
    case "recording":
    case "paused":
    case "interrupted":
    case "stopped":
      return value;
    default:
      return "interrupted";
  }
}

export function isRecordingLabelAllowed(
  session: SessionSnapshot,
  service: ServiceSnapshot,
): boolean {
  return (
    service.alive === true &&
    service.phase === "recording" &&
    session.state === "recording"
  );
}

/**
 * Reconcile persisted metadata with the service.
 * A saved "recording" or "paused" session becomes interrupted when the
 * service is not alive to confirm it. The partial file is left in place.
 */
export function reconcileSession(
  persisted: SessionSnapshot,
  service: ServiceSnapshot,
): SessionSnapshot {
  if (service.alive && service.phase === "recording") {
    return { state: "recording", elapsedMs: service.elapsedMs };
  }
  if (service.alive && service.phase === "paused") {
    return { state: "paused", elapsedMs: service.elapsedMs };
  }
  if (persisted.state === "recording" || persisted.state === "paused") {
    return { state: "interrupted", elapsedMs: persisted.elapsedMs };
  }
  return {
    state: persisted.state,
    elapsedMs: persisted.elapsedMs,
  };
}

export function projectVisibleState(
  persisted: SessionSnapshot,
  service: ServiceSnapshot,
): VisibleSession {
  const session = reconcileSession(persisted, service);
  return {
    ...session,
    showRecording: isRecordingLabelAllowed(session, service),
  };
}

export type SessionCommand =
  | { type: "start"; appInForeground: boolean; serviceAccepted: boolean }
  | { type: "pause"; serviceAccepted: boolean }
  | { type: "resume"; appInForeground: boolean; serviceAccepted: boolean }
  | { type: "stop"; serviceAccepted: boolean }
  | { type: "serviceEnded" }
  | { type: "launch"; serviceAlive: boolean };

export interface CommandResult {
  state: SessionState;
  accepted: boolean;
  reason?: string;
}

/**
 * Pure transitions. Entering `recording` requires a foreground user action
 * and an explicit acceptance from the service. This does not replace
 * `projectVisibleState` for what the UI renders on later ticks.
 */
export function reduceSession(
  state: SessionState,
  command: SessionCommand,
): CommandResult {
  switch (command.type) {
    case "start": {
      const idleLike =
        state === "idle" || state === "stopped" || state === "interrupted";
      if (!idleLike) {
        return { state, accepted: false, reason: "not-idle" };
      }
      if (!command.appInForeground) {
        return { state, accepted: false, reason: "backgrounded" };
      }
      if (!command.serviceAccepted) {
        return { state, accepted: false, reason: "service-rejected" };
      }
      return { state: "recording", accepted: true };
    }
    case "pause": {
      if (state !== "recording") {
        return { state, accepted: false, reason: "not-recording" };
      }
      if (!command.serviceAccepted) {
        return { state, accepted: false, reason: "service-rejected" };
      }
      return { state: "paused", accepted: true };
    }
    case "resume": {
      if (state !== "paused") {
        return { state, accepted: false, reason: "not-paused" };
      }
      if (!command.appInForeground) {
        return { state, accepted: false, reason: "backgrounded" };
      }
      if (!command.serviceAccepted) {
        return { state, accepted: false, reason: "service-rejected" };
      }
      return { state: "recording", accepted: true };
    }
    case "stop": {
      if (state !== "recording" && state !== "paused") {
        return { state, accepted: false, reason: "not-active" };
      }
      if (!command.serviceAccepted) {
        return { state, accepted: false, reason: "service-rejected" };
      }
      return { state: "stopped", accepted: true };
    }
    case "serviceEnded": {
      if (state === "recording" || state === "paused") {
        return { state: "interrupted", accepted: true };
      }
      return { state, accepted: false, reason: "not-active" };
    }
    case "launch": {
      if (
        (state === "recording" || state === "paused") &&
        !command.serviceAlive
      ) {
        return { state: "interrupted", accepted: true };
      }
      return { state, accepted: true };
    }
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}

/**
 * Elapsed capture time. Paused gaps are not added: pass `running: false`
 * and the accumulated total from the last active segment.
 */
export function recordingElapsedMs(input: {
  accumulatedMs: number;
  segmentStartedAtElapsedMs: number | null;
  nowElapsedMs: number;
  running: boolean;
}): number {
  if (!input.running || input.segmentStartedAtElapsedMs == null) {
    return Math.max(0, input.accumulatedMs);
  }
  const delta = input.nowElapsedMs - input.segmentStartedAtElapsedMs;
  return Math.max(0, input.accumulatedMs + Math.max(0, delta));
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

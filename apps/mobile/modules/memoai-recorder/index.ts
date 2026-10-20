import { type NativeModule, requireNativeModule } from "expo";

export type RecorderPhase =
  | "idle"
  | "recording"
  | "paused"
  | "interrupted"
  | "stopped";

export type RecorderStatus = {
  serviceAlive: boolean;
  phase: RecorderPhase;
  sessionId: string | null;
  elapsedMs: number;
  fileUri: string | null;
  pausedByFocus: boolean;
  lastError: string | null;
};

export type LocalRecordingRecord = {
  id: string;
  fileUri: string | null;
  state: RecorderPhase;
  elapsedMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  playable: boolean;
  corrupt: boolean;
};

type MemoAiRecorderEvents = {
  onChange: (status: RecorderStatus) => void;
};

declare class MemoAiRecorderModule extends NativeModule<MemoAiRecorderEvents> {
  getStatus(): RecorderStatus;
  reconcile(): RecorderStatus;
  listRecordings(): LocalRecordingRecord[];
  start(): Promise<RecorderStatus>;
  pause(): Promise<RecorderStatus>;
  resume(): Promise<RecorderStatus>;
  stop(): Promise<RecorderStatus>;
}

let cached: MemoAiRecorderModule | null | undefined;

/** Null when this install has no native module (for example Expo Go). */
export function getRecorder(): MemoAiRecorderModule | null {
  if (cached !== undefined) {
    return cached;
  }
  try {
    cached = requireNativeModule<MemoAiRecorderModule>("MemoAiRecorder");
  } catch {
    cached = null;
  }
  return cached;
}

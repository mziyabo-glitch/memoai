import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from "expo-audio";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  formatDuration,
  parseSessionState,
  projectVisibleState,
  type SessionState,
  type VisibleSession,
} from "@memoai/shared";
import {
  getRecorder,
  type LocalRecordingRecord,
  type RecorderStatus,
} from "memoai-recorder";
import {
  capturePermissionGranted,
  readCapturePermission,
  requestCapturePermission,
  type CapturePermission,
} from "./permissions";
import {
  acknowledgeParticipantNotice,
  hasAcknowledgedParticipantNotice,
} from "./privacy";
import { theme } from "./theme";

type Gate = "loading" | "privacy" | "explain" | "ready";

const idleVisible: VisibleSession = {
  state: "idle",
  elapsedMs: 0,
  showRecording: false,
};

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}

function projectStatus(status: RecorderStatus): VisibleSession {
  const persistedState: SessionState = parseSessionState(status.phase);
  const phase =
    status.phase === "recording" || status.phase === "paused"
      ? status.phase
      : "idle";
  return projectVisibleState(
    { state: persistedState, elapsedMs: status.elapsedMs },
    {
      alive: status.serviceAlive,
      phase,
      elapsedMs: status.elapsedMs,
    },
  );
}

function statusLabel(visible: VisibleSession): string {
  if (visible.showRecording) {
    return "Recording";
  }
  switch (visible.state) {
    case "paused":
      return "Paused";
    case "interrupted":
      return "Interrupted";
    case "stopped":
      return "Saved";
    default:
      return "Ready";
  }
}

export function RecorderScreen() {
  const recorder = getRecorder();
  const player = useAudioPlayer();
  const playback = useAudioPlayerStatus(player);
  const [gate, setGate] = useState<Gate>("loading");
  const [permission, setPermission] = useState<CapturePermission>({
    microphone: false,
    notifications: false,
  });
  const [denied, setDenied] = useState(false);
  const [visible, setVisible] = useState<VisibleSession>(idleVisible);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<LocalRecordingRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const [pausedByFocus, setPausedByFocus] = useState(false);

  const refreshLibrary = useCallback(() => {
    if (!recorder) {
      return;
    }
    setRecordings(recorder.listRecordings());
  }, [recorder]);

  const refreshStatus = useCallback(() => {
    if (!recorder) {
      return;
    }
    const status = recorder.getStatus();
    setSessionId(status.sessionId);
    setPausedByFocus(status.pausedByFocus);
    const next = projectStatus(status);
    setVisible(next);
    return next;
  }, [recorder]);

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: "mixWithOthers",
      allowsRecording: false,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
      allowsBackgroundRecording: false,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const acknowledged = await hasAcknowledgedParticipantNotice();
      const current = await readCapturePermission();
      if (cancelled) {
        return;
      }
      setPermission(current);
      if (!acknowledged) {
        setGate("privacy");
        return;
      }
      setGate(capturePermissionGranted(current) ? "ready" : "explain");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!recorder || gate !== "ready") {
      return;
    }
    let cancelled = false;
    recorder.reconcile();
    refreshStatus();
    refreshLibrary();
    const timer = setInterval(() => {
      refreshStatus();
    }, 250);
    const libraryTimer = setInterval(() => {
      refreshLibrary();
    }, 2000);
    const appState = AppState.addEventListener("change", (next) => {
      if (next !== "active") {
        return;
      }
      void (async () => {
        const current = await readCapturePermission();
        if (cancelled) {
          return;
        }
        setPermission(current);
        if (!capturePermissionGranted(current)) {
          setDenied(true);
          setGate("explain");
          return;
        }
        recorder.reconcile();
        refreshStatus();
        refreshLibrary();
      })();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(libraryTimer);
      appState.remove();
    };
  }, [gate, recorder, refreshLibrary, refreshStatus]);

  async function onAcknowledge() {
    await acknowledgeParticipantNotice();
    const current = await readCapturePermission();
    setPermission(current);
    setGate(capturePermissionGranted(current) ? "ready" : "explain");
  }

  async function onRequestPermissions() {
    setDenied(false);
    const next = await requestCapturePermission();
    setPermission(next);
    if (capturePermissionGranted(next)) {
      setGate("ready");
      return;
    }
    setDenied(true);
  }

  async function runCommand(action: "start" | "pause" | "resume" | "stop") {
    if (!recorder || busy) {
      return;
    }
    if ((action === "start" || action === "resume") && AppState.currentState !== "active") {
      setError("Open MemoAI and use the button while it is on screen.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const status = await recorder[action]();
      setSessionId(status.sessionId);
      setPausedByFocus(status.pausedByFocus);
      setVisible(projectStatus(status));
      refreshLibrary();
    } catch (commandError) {
      setError(messageOf(commandError));
      if (recorder) {
        recorder.reconcile();
        refreshStatus();
        refreshLibrary();
      }
    } finally {
      setBusy(false);
    }
  }

  function togglePlayback(recording: LocalRecordingRecord) {
    if (!recording.fileUri || !recording.playable) {
      return;
    }
    if (visible.showRecording || visible.state === "paused") {
      setError("Stop or wait until the microphone is free before playback.");
      return;
    }
    try {
      if (playingUri === recording.fileUri && playback.playing) {
        player.pause();
        return;
      }
      if (playingUri !== recording.fileUri) {
        player.replace(recording.fileUri);
        setPlayingUri(recording.fileUri);
      }
      player.play();
    } catch (playError) {
      setError(messageOf(playError));
    }
  }

  if (!recorder) {
    return (
      <Shell>
        <Text style={styles.mark}>MemoAI</Text>
        <Text style={styles.title}>Development build required</Text>
        <Text style={styles.body}>
          Recording uses a native Android microphone foreground service. Expo Go
          does not include it. Install the EAS development APK, then open this
          project from that app.
        </Text>
      </Shell>
    );
  }

  if (gate === "loading") {
    return (
      <Shell>
        <Text style={styles.mark}>MemoAI</Text>
      </Shell>
    );
  }

  if (gate === "privacy") {
    return (
      <Shell>
        <Text style={styles.mark}>MemoAI</Text>
        <Text style={styles.title}>Tell people they are being recorded</Text>
        <Text style={styles.body}>
          MemoAI does not notify the other people in the room. Before you start,
          tell everyone that this phone is recording them.
        </Text>
        <Pressable style={styles.primary} onPress={() => void onAcknowledge()}>
          <Text style={styles.primaryText}>I will tell everyone</Text>
        </Pressable>
        <Text style={styles.fine}>Stored only on this phone.</Text>
      </Shell>
    );
  }

  if (gate === "explain") {
    return (
      <Shell>
        <Text style={styles.mark}>MemoAI</Text>
        <Text style={styles.title}>Microphone and notification</Text>
        <Text style={styles.body}>
          The microphone records meeting audio into a file on this phone.
          Recording continues when the screen locks or you switch apps, because
          Android keeps a microphone foreground service running.
        </Text>
        <Text style={styles.body}>
          Notifications are required so Android can show an ongoing “MemoAI is
          recording” alert with a Stop button. The system microphone indicator
          stays visible. MemoAI does not hide it.
        </Text>
        {denied ? (
          <Text style={styles.error}>
            MemoAI can’t record until both permissions are allowed.
            {permission.microphone ? "" : " Microphone is off."}
            {permission.notifications ? "" : " Notifications are off."}
          </Text>
        ) : null}
        <Pressable style={styles.primary} onPress={() => void onRequestPermissions()}>
          <Text style={styles.primaryText}>Continue to the system prompt</Text>
        </Pressable>
        {denied ? (
          <Pressable style={styles.secondary} onPress={() => void Linking.openSettings()}>
            <Text style={styles.secondaryText}>Open settings</Text>
          </Pressable>
        ) : null}
      </Shell>
    );
  }

  const canStart =
    !busy &&
    !visible.showRecording &&
    visible.state !== "paused" &&
    (visible.state === "idle" ||
      visible.state === "stopped" ||
      visible.state === "interrupted");
  const canPause = !busy && (visible.showRecording || pausedByFocus);
  const canResume = !busy && visible.state === "paused";
  const canStop = !busy && (visible.showRecording || visible.state === "paused");
  const timerMs =
    visible.state === "idle" ? 0 : visible.elapsedMs;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.mark}>MemoAI</Text>
        <Text style={styles.kicker}>On this phone. No account.</Text>
        <View style={styles.timerBlock}>
          <Text style={styles.timer}>{formatDuration(timerMs)}</Text>
          <View style={styles.statusRow}>
            {visible.showRecording ? <View style={styles.dot} /> : null}
            <Text style={styles.status}>{statusLabel(visible)}</Text>
          </View>
          <Text style={styles.hint}>
            {hintFor(
              visible,
              recordings.find((recording) => recording.id === sessionId),
              pausedByFocus,
            )}
          </Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.controls}>
          <Control label="Start" enabled={canStart} onPress={() => void runCommand("start")} tone="record" />
          <Control label="Pause" enabled={canPause} onPress={() => void runCommand("pause")} />
          <Control label="Resume" enabled={canResume} onPress={() => void runCommand("resume")} tone="record" />
          <Control label="Stop" enabled={canStop} onPress={() => void runCommand("stop")} />
        </View>
        <Text style={styles.section}>Library</Text>
        {recordings.length === 0 ? (
          <Text style={styles.body}>No recordings yet.</Text>
        ) : (
          recordings.map((recording) => {
            const active =
              playingUri === recording.fileUri && playback.playing;
            const locked =
              visible.showRecording || visible.state === "paused";
            return (
              <View key={recording.id} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>
                    {formatDuration(recording.elapsedMs)}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {libraryState(recording, visible, sessionId)} ·{" "}
                    {new Date(recording.startedAtMs).toLocaleString()}
                  </Text>
                </View>
                <Pressable
                  style={[
                    styles.play,
                    (!recording.playable || locked) && styles.playDisabled,
                  ]}
                  disabled={!recording.playable || locked}
                  onPress={() => togglePlayback(recording)}
                >
                  <Text style={styles.playText}>
                    {active ? "Pause" : "Play"}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function hintFor(
  visible: VisibleSession,
  active: LocalRecordingRecord | undefined,
  pausedByFocus: boolean,
): string {
  if (visible.showRecording) {
    return "Locking the screen or switching apps keeps this service recording.";
  }
  if (visible.state === "paused") {
    if (pausedByFocus) {
      return "Paused while another app uses audio. Tap Pause to stay paused. Otherwise recording resumes when the microphone is free. Paused time is not counted.";
    }
    return "Paused time is not added to the duration.";
  }
  if (visible.state === "interrupted") {
    if (!active || active.corrupt || !active.playable) {
      return "The file is still on this phone, but it may be incomplete and cannot be played.";
    }
    return "Android stopped the recording. The partial audio is still on this phone.";
  }
  if (visible.state === "stopped") {
    return "Saved in the library below.";
  }
  return "Start when everyone knows they are being recorded.";
}

function libraryState(
  recording: LocalRecordingRecord,
  visible: VisibleSession,
  sessionId: string | null,
): string {
  if (recording.id === sessionId && visible.showRecording) {
    return "Recording";
  }
  if (recording.id === sessionId && visible.state === "paused") {
    return "Paused";
  }
  if (recording.corrupt || !recording.playable) {
    return "Incomplete";
  }
  const parsed = parseSessionState(recording.state);
  if (parsed === "stopped") {
    return "Saved";
  }
  if (parsed === "interrupted" || parsed === "recording" || parsed === "paused") {
    return "Interrupted";
  }
  return "Incomplete";
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.scroll}>{children}</View>
    </SafeAreaView>
  );
}

function Control({
  label,
  enabled,
  onPress,
  tone,
}: {
  label: string;
  enabled: boolean;
  onPress: () => void;
  tone?: "record";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!enabled}
      onPress={onPress}
      style={[
        styles.control,
        tone === "record" && styles.controlRecord,
        !enabled && styles.controlDisabled,
      ]}
    >
      <Text
        style={[
          styles.controlText,
          tone === "record" && styles.controlTextDark,
          !enabled && styles.controlTextDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  scroll: {
    paddingHorizontal: 24,
    paddingBottom: 48,
    gap: 16,
  },
  mark: {
    color: theme.accent,
    fontSize: 13,
    letterSpacing: 2.4,
    textTransform: "uppercase",
    marginTop: 12,
  },
  kicker: {
    color: theme.muted,
    fontSize: 15,
    marginTop: -8,
  },
  title: {
    color: theme.text,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: "600",
  },
  body: {
    color: theme.muted,
    fontSize: 16,
    lineHeight: 24,
  },
  fine: {
    color: theme.muted,
    fontSize: 13,
  },
  timerBlock: {
    marginTop: 28,
    gap: 8,
  },
  timer: {
    color: theme.text,
    fontSize: 68,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
    letterSpacing: -1,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.record,
  },
  status: {
    color: theme.text,
    fontSize: 18,
  },
  hint: {
    color: theme.muted,
    fontSize: 15,
    lineHeight: 22,
  },
  error: {
    color: theme.dangerText,
    fontSize: 15,
    lineHeight: 22,
  },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 8,
  },
  control: {
    width: "47%",
    backgroundColor: theme.surfaceRaised,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.line,
  },
  controlRecord: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  controlDisabled: {
    opacity: 0.35,
  },
  controlText: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "600",
  },
  controlTextDark: {
    color: "#1A140C",
  },
  controlTextDisabled: {
    color: theme.text,
  },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  primaryText: {
    color: "#1A140C",
    fontSize: 16,
    fontWeight: "600",
  },
  secondary: {
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.line,
  },
  secondaryText: {
    color: theme.text,
    fontSize: 16,
  },
  section: {
    color: theme.text,
    fontSize: 13,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    marginTop: 20,
  },
  row: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: theme.line,
  },
  rowText: {
    flex: 1,
    gap: 4,
  },
  rowTitle: {
    color: theme.text,
    fontSize: 18,
    fontVariant: ["tabular-nums"],
  },
  rowMeta: {
    color: theme.muted,
    fontSize: 13,
  },
  play: {
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.line,
  },
  playDisabled: {
    opacity: 0.35,
  },
  playText: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "600",
  },
});

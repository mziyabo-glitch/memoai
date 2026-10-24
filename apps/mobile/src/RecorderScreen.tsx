import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AppState,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from "expo-audio";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  SAMPLE_NOTE_DRAFTS,
  acceptNotesConsent,
  cleanTitle,
  deleteJob,
  describeCloud,
  formatDuration,
  formatFileSize,
  groundNotes,
  locateAudioSection,
  matchesTitleQuery,
  parseSessionState,
  projectVisibleState,
  recordingNotesLabel,
  recordingNotesPhase,
  sampleNotesLabel,
  storagePaths,
  type NotesConsentRecord,
  type ProcessJob,
  type SectionInput,
  type SessionState,
  type VisibleSession,
} from "@memoai/shared";
import {
  getRecorder,
  type LocalRecordingRecord,
  type RecorderStatus,
  type RecoveryFile,
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
import { getSupabase, supabaseConfigured } from "./account";
import {
  loadAcknowledgedSections,
  loadConsents,
  loadTitles,
  saveAcknowledgedSections,
  saveConsent,
  saveTitle,
} from "./libraryMeta";
import { AccountScreen, ConsentScreen, RecordingNotesScreen, SampleNotesScreen } from "./notesUi";
import { deleteUploadedAudio, uploadFinishedAudio } from "./uploadAudio";
import { theme } from "./theme";

type Gate = "loading" | "privacy" | "explain" | "ready";

type Route =
  | { name: "library" }
  | { name: "recording"; id: string }
  | { name: "consent"; id: string }
  | { name: "sample"; id: string }
  | { name: "account" };

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
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [partNumber, setPartNumber] = useState(1);
  const [recoveryFiles, setRecoveryFiles] = useState<RecoveryFile[]>([]);
  const [storageBytes, setStorageBytes] = useState(0);
  const playlist = useRef<string[]>([]);
  const playlistIndex = useRef(0);
  const playlistOrigin = useRef(0);
  const [pausedByFocus, setPausedByFocus] = useState(false);
  const [route, setRoute] = useState<Route>({ name: "library" });
  const [titleQuery, setTitleQuery] = useState("");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [consents, setConsents] = useState<Record<string, NotesConsentRecord>>({});
  const [sampleDone, setSampleDone] = useState<Record<string, readonly string[]>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [acks, setAcks] = useState<Record<string, { sequence: number; sha256: string }[]>>({});
  const [cloudJobs, setCloudJobs] = useState<Record<string, ProcessJob | null>>({});
  const [cloudUploads, setCloudUploads] = useState<
    Record<string, { done: number; total: number; status: "uploading" | "interrupted" | "cancelled" | "complete" }>
  >({});
  const cancelUpload = useRef(false);

  const refreshLibrary = useCallback(() => {
    if (!recorder) {
      return;
    }
    setRecordings(recorder.listRecordings());
    setRecoveryFiles(recorder.listRecoveryFiles());
    setStorageBytes(recorder.storageBytes());
  }, [recorder]);

  useEffect(() => {
    if (!playback.didJustFinish || playlist.current.length === 0) return;
    const nextIndex = playlistIndex.current + 1;
    const next = playlist.current[nextIndex];
    if (!next) {
      playlist.current = [];
      playlistOrigin.current = 0;
      setPlayingId(null);
      setPlayingUri(null);
      return;
    }
    playlistIndex.current = nextIndex;
    setPartNumber(playlistOrigin.current + nextIndex + 1);
    setPlayingUri(next);
    player.replace(next);
    player.play();
  }, [playback.didJustFinish, player]);

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
    if (gate !== "ready") {
      return;
    }
    let cancelled = false;
    void (async () => {
      const [storedTitles, storedConsents] = await Promise.all([
        loadTitles(),
        loadConsents(),
      ]);
      const storedAcks = await loadAcknowledgedSections();
      const supabase = getSupabase();
      const session = supabase ? await supabase.auth.getSession() : null;
      if (!cancelled) {
        setTitles(storedTitles);
        setConsents(storedConsents);
        setAcks(storedAcks);
        setAccountEmail(session?.data.session?.user.email ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

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
      if (action === "start" || action === "resume") {
        player.pause();
        playlist.current = [];
        playlistOrigin.current = 0;
        setPlayingId(null);
        setPlayingUri(null);
      }
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

  function playFromMs(recording: LocalRecordingRecord, startMs: number) {
    if (!recording.playable) {
      return;
    }
    if (visible.showRecording || visible.state === "paused") {
      setError("Stop or wait until the microphone is free before playback.");
      return;
    }
    const located = locateAudioSection(recording.parts, startMs);
    const uri = located ? recording.parts[located.partIndex]?.fileUri : null;
    if (!located || !uri) {
      setError("That time is past the saved audio.");
      return;
    }
    try {
      playlist.current = recording.parts.slice(located.partIndex).map((part) => part.fileUri);
      playlistIndex.current = 0;
      playlistOrigin.current = located.partIndex;
      setPartNumber(located.partIndex + 1);
      setPlayingId(recording.id);
      player.replace(uri);
      setPlayingUri(uri);
      if (located.offsetMs > 0) {
        void player.seekTo(located.offsetMs / 1000);
      }
      player.play();
    } catch (playError) {
      setError(messageOf(playError));
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
      if (playingId === recording.id && playback.playing) {
        player.pause();
        void player.seekTo(0);
        playlist.current = [];
        playlistOrigin.current = 0;
        setPlayingId(null);
        return;
      }
      playlist.current = recording.parts.map((part) => part.fileUri);
      playlistIndex.current = 0;
      playlistOrigin.current = 0;
      setPartNumber(1);
      setPlayingId(recording.id);
      player.replace(recording.fileUri);
      setPlayingUri(recording.fileUri);
      player.play();
    } catch (playError) {
      setError(messageOf(playError));
    }
  }

  async function recoveryAction(action: "recoverFile" | "exportRecoveryFile" | "deleteRecoveryFile", name: string) {
    if (!recorder || busy) return;
    setBusy(true);
    setError(null);
    try {
      await recorder[action](name);
      recorder.reconcile();
      refreshLibrary();
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); }
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

  const samples = __DEV__ ? SAMPLE_NOTE_DRAFTS : [];
  const playbackLocked = visible.showRecording || visible.state === "paused";

  async function updateTitle(id: string, value: string | null) {
    try {
      setTitles(await saveTitle(id, value));
    } catch (failure) {
      setError(messageOf(failure));
    }
  }

  async function agreeToNotes(recordingId: string) {
    const result = acceptNotesConsent();
    if (result.uploaded || result.providerCalled || result.status !== "not-processed") {
      return;
    }
    try {
      setConsents(await saveConsent(recordingId, new Date().toISOString()));
      setRoute({ name: "recording", id: recordingId });
    } catch (failure) {
      setError(messageOf(failure));
    }
  }

  function displayTitle(id: string, fallback: string): string {
    return titles[id] ?? fallback;
  }

  function notesPhase(recording: LocalRecordingRecord) {
    return recordingNotesPhase({
      live: recording.id === sessionId && playbackLocked,
      playableParts: recording.parts.length,
      elapsedMs: recording.elapsedMs,
      consented: consents[recording.id] != null,
    });
  }

  function cloudFor(recordingId: string) {
    return describeCloud({
      signedIn: accountEmail != null,
      consented: consents[recordingId] != null,
      upload: cloudUploads[recordingId] ?? null,
      job: cloudJobs[recordingId] ?? null,
    });
  }

  async function sectionsFor(recording: LocalRecordingRecord): Promise<SectionInput[]> {
    const parts = recording.parts.map((part) => ({ ...part }));
    if (parts.length === 1 && !parts[0]?.sha256 && recorder && typeof recorder.hashLegacyFile === "function") {
      try {
        const sha256 = await recorder.hashLegacyFile(recording.id);
        parts[0] = { ...parts[0], sha256 };
      } catch (failure) {
        setError(messageOf(failure));
      }
    }
    return parts.map((part, index) => ({
      sequence: index,
      sha256: part.sha256 ?? "",
      sizeBytes: part.sizeBytes ?? 0,
      durationMs: part.durationMs,
      finished: part.finished !== false,
    }));
  }

  async function beginUpload(recording: LocalRecordingRecord) {
    cancelUpload.current = false;
    const sections = await sectionsFor(recording);
    setCloudUploads((current) => ({
      ...current,
      [recording.id]: { done: 0, total: Math.max(sections.length, 1), status: "uploading" },
    }));
    const outcome = await uploadFinishedAudio({
      recordingId: recording.id,
      title: displayTitle(recording.id, recordingFallbackTitle(recording)),
      consentAt: consents[recording.id]?.agreedAt ?? null,
      sections,
      acknowledged: acks[recording.id] ?? [],
      cancelled: () => cancelUpload.current,
      onProgress: (done, total) => {
        setCloudUploads((current) => ({
          ...current,
          [recording.id]: { done, total, status: "uploading" },
        }));
      },
      readFile: async (section) => {
        const uri = recording.parts[section.sequence]?.fileUri;
        if (!uri) throw new Error("That section has no audio file.");
        const response = await fetch(uri);
        return new Uint8Array(await response.arrayBuffer());
      },
    });
    setAcks(await saveAcknowledgedSections(recording.id, outcome.acknowledged));
    if (!outcome.ok) {
      setCloudUploads((current) => {
        const next = { ...current };
        delete next[recording.id];
        return next;
      });
      setError(outcome.reason);
      return;
    }
    setCloudJobs((current) => ({ ...current, [recording.id]: outcome.job }));
    setCloudUploads((current) => ({
      ...current,
      [recording.id]: { done: outcome.acknowledged.length, total: outcome.acknowledged.length, status: "complete" },
    }));
  }

  async function removeUpload(recordingId: string) {
    const job = cloudJobs[recordingId];
    if (!job) return;
    const removed = deleteJob(job);
    const supabase = getSupabase();
    const session = supabase ? await supabase.auth.getSession() : null;
    const ownerId = session?.data.session?.user.id;
    if (ownerId) {
      const result = await deleteUploadedAudio({
        ownerId,
        paths: removed.paths.length > 0 ? removed.paths : storagePaths(job),
        localRecordingId: recordingId,
      });
      if (!result.ok && result.reason) setError(result.reason);
    }
    setCloudJobs((current) => ({ ...current, [recordingId]: removed.job }));
    setCloudUploads((current) => {
      const next = { ...current };
      delete next[recordingId];
      return next;
    });
  }

  async function signIn(email: string, password: string, create: boolean) {
    const supabase = getSupabase();
    if (!supabase) {
      setError("Supabase is not configured on this phone.");
      return;
    }
    const result = create
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setAccountEmail(result.data.user?.email ?? email);
    setError(null);
    setRoute({ name: "library" });
  }

  const openRecording =
    route.name === "recording" || route.name === "consent"
      ? recordings.find((recording) => recording.id === route.id)
      : undefined;
  const sampleDraft =
    route.name === "sample" ? samples.find((draft) => draft.id === route.id) : undefined;
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

  if (route.name !== "library") {
    const live = playbackLocked ? (
      <View style={styles.timerBlock}>
        <Text style={styles.status}>
          {statusLabel(visible)} · {formatDuration(visible.elapsedMs)}
        </Text>
        <View style={styles.controls}>
          <Control label="Pause" enabled={canPause} onPress={() => void runCommand("pause")} />
          <Control label="Resume" enabled={canResume} onPress={() => void runCommand("resume")} tone="record" />
          <Control label="Stop" enabled={canStop} onPress={() => void runCommand("stop")} />
        </View>
      </View>
    ) : null;
    let screen = (
      <View style={styles.stack}>
        <Text style={styles.body}>That item is no longer on this phone.</Text>
        <Pressable accessibilityRole="button" onPress={() => setRoute({ name: "library" })}>
          <Text style={styles.backLink}>Library</Text>
        </Pressable>
      </View>
    );
    if (route.name === "account") {
      screen = (
        <AccountScreen
          configured={supabaseConfigured()}
          email={accountEmail}
          onBack={() => setRoute({ name: "library" })}
          onSignIn={(email, password) => void signIn(email, password, false)}
          onCreateAccount={(email, password) => void signIn(email, password, true)}
          onSignOut={() => {
            void getSupabase()?.auth.signOut();
            setAccountEmail(null);
          }}
          error={error}
        />
      );
    } else if (route.name === "sample" && sampleDraft) {
      screen = (
        <SampleNotesScreen
          draft={sampleDraft}
          title={displayTitle(sampleDraft.id, sampleDraft.defaultTitle)}
          onTitle={(next) => void updateTitle(sampleDraft.id, next)}
          onBack={() => setRoute({ name: "library" })}
          doneIds={sampleDone[sampleDraft.id] ?? []}
          onToggle={(actionId) => {
            setSampleDone((current) => {
              const existing = current[sampleDraft.id] ?? [];
              const next = existing.includes(actionId)
                ? existing.filter((id) => id !== actionId)
                : [...existing, actionId];
              return { ...current, [sampleDraft.id]: next };
            });
          }}
          onShareError={setError}
        />
      );
    } else if (openRecording && route.name === "consent") {
      const phase = notesPhase(openRecording);
      screen = (
        <ConsentScreen
          allowAgree={phase === "none"}
          alreadySaved={phase === "not-processed"}
          blockedReason={
            phase === "too-long"
              ? "This recording is longer than 90 minutes, so permission is not saved."
              : phase === "no-audio"
                ? "There is no finished audio to transcribe."
                : phase === "live"
                  ? "Stop the recording before creating notes."
                  : null
          }
          onAgree={() => void agreeToNotes(openRecording.id)}
          onBack={() => setRoute({ name: "recording", id: openRecording.id })}
        />
      );
    } else if (openRecording && route.name === "recording") {
      screen = (
        <RecordingNotesScreen
          title={displayTitle(openRecording.id, recordingFallbackTitle(openRecording))}
          onTitle={(next) => void updateTitle(openRecording.id, next)}
          onBack={() => setRoute({ name: "library" })}
          phase={notesPhase(openRecording)}
          parts={openRecording.parts}
          durationLabel={formatDuration(openRecording.elapsedMs)}
          dateLabel={`${recordingDate(openRecording.startedAtMs)} · ${recordingTime(openRecording.startedAtMs)}`}
          sizeLabel={formatFileSize(openRecording.sizeBytes)}
          incompleteParts={openRecording.incompleteParts}
          onCreateNotes={() => setRoute({ name: "consent", id: openRecording.id })}
          onPlayAt={(startMs) => playFromMs(openRecording, startMs)}
          playDisabled={playbackLocked || !openRecording.playable}
          playingPart={
            playingId === openRecording.id && playingUri !== null && playback.playing
              ? partNumber
              : null
          }
          error={error}
          cloudLabel={cloudFor(openRecording.id).label}
          cloudDetail={cloudFor(openRecording.id).detail}
          onSignIn={() => setRoute({ name: "account" })}
          onUpload={() => void beginUpload(openRecording)}
          onCancelCloud={() => {
            cancelUpload.current = true;
          }}
          onDeleteUpload={() => void removeUpload(openRecording.id)}
        />
      );
    }
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.mark}>MemoAI</Text>
          {live}
          {error && route.name !== "recording" ? <Text style={styles.error}>{error}</Text> : null}
          {screen}
        </ScrollView>
      </SafeAreaView>
    );
  }

  const timerMs =
    visible.state === "idle" ? 0 : visible.elapsedMs;
  const visibleRecordings = recordings.filter((recording) =>
    matchesTitleQuery(
      displayTitle(recording.id, recordingFallbackTitle(recording)),
      titleQuery,
    ),
  );
  const visibleSamples = samples.filter((draft) =>
    matchesTitleQuery(displayTitle(draft.id, draft.defaultTitle), titleQuery),
  );

  function beginRename(id: string, current: string) {
    setEditingId(id);
    setEditingValue(current);
  }

  function commitRename(id: string) {
    void updateTitle(id, cleanTitle(editingValue));
    setEditingId(null);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.mark}>MemoAI</Text>
        <Text style={styles.kicker}>
          {accountEmail ? `On this phone. ${accountEmail}` : "On this phone. No account."}
        </Text>
        <Pressable accessibilityRole="button" onPress={() => setRoute({ name: "account" })}>
          <Text style={styles.backLink}>{accountEmail ? "Account" : "Sign in for notes"}</Text>
        </Pressable>
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
        <View style={styles.libraryHeader}>
          <Text style={styles.section}>Library</Text>
          <Text style={styles.storageTotal}>
            {formatFileSize(storageBytes)}{" "}
            stored on this phone
          </Text>
        </View>
        <TextInput
          accessibilityLabel="Search by title"
          value={titleQuery}
          onChangeText={setTitleQuery}
          placeholder="Search by title"
          placeholderTextColor={theme.muted}
          style={styles.search}
        />
        {recordings.length === 0 && titleQuery.trim() === "" ? (
          <Text style={styles.body}>No recordings yet.</Text>
        ) : visibleRecordings.length === 0 ? (
          <Text style={styles.body}>No recordings match that title.</Text>
        ) : (
          visibleRecordings.map((recording) => {
            const playingThis =
              playingId === recording.id && playingUri !== null && playback.playing;
            const locked = playbackLocked;
            const title = displayTitle(recording.id, recordingFallbackTitle(recording));
            const editing = editingId === recording.id;
            return (
              <View key={recording.id} style={styles.row}>
                <View style={styles.rowText}>
                  {editing ? (
                    <TextInput
                      accessibilityLabel="Recording title"
                      value={editingValue}
                      onChangeText={setEditingValue}
                      onEndEditing={() => commitRename(recording.id)}
                      onSubmitEditing={() => commitRename(recording.id)}
                      maxLength={80}
                      returnKeyType="done"
                      style={styles.rowTitle}
                    />
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${title}`}
                      onPress={() => setRoute({ name: "recording", id: recording.id })}
                    >
                      <Text style={styles.rowTitle}>{title}</Text>
                    </Pressable>
                  )}
                  <Text style={styles.notesStatus}>
                    {recordingNotesLabel(notesPhase(recording))}
                    {cloudJobs[recording.id] || cloudUploads[recording.id]
                      ? ` · ${cloudFor(recording.id).label}`
                      : ""}
                  </Text>
                  <Text style={styles.rowState}>
                    {libraryState(recording, visible, sessionId)}
                  </Text>
                  <Fact label="Duration" value={formatDuration(recording.elapsedMs)} />
                  <Fact label="Date" value={recordingDate(recording.startedAtMs)} />
                  <Fact label="Time" value={recordingTime(recording.startedAtMs)} />
                  <Fact label="Saved sections" value={String(recording.parts.length)} />
                  {playingThis && recording.parts.length > 1 && (
                    <Text style={styles.body}>Playing section {partNumber} of {recording.parts.length}</Text>
                  )}
                  {recording.incompleteParts > 0 && (
                    <Text style={styles.body}>{recording.incompleteParts} section(s) unfinished or missing. Play includes saved audio only.</Text>
                  )}
                  <Fact
                    label="Size"
                    value={formatFileSize(recording.sizeBytes)}
                    emphasize
                  />
                  <View style={styles.rowActions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Rename ${title}`}
                      onPress={() => beginRename(recording.id, title)}
                      style={styles.play}
                    >
                      <Text style={styles.playText}>Rename</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${title}`}
                      onPress={() => setRoute({ name: "recording", id: recording.id })}
                      style={styles.play}
                    >
                      <Text style={styles.playText}>Open</Text>
                    </Pressable>
                  </View>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    playingThis ? "Stop playback" : "Play recording"
                  }
                  style={[
                    styles.play,
                    (!recording.playable || locked) && styles.playDisabled,
                  ]}
                  disabled={!recording.playable || locked}
                  onPress={() => togglePlayback(recording)}
                >
                  <Text style={styles.playText}>
                    {playingThis ? "Stop play" : "Play"}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
        {visibleSamples.length > 0 ? (
          <View style={styles.libraryHeader}>
            <Text style={styles.section}>Samples</Text>
            <Text style={styles.body}>
              Development only. These notes were not created from a recording on this phone.
            </Text>
            {visibleSamples.map((draft) => {
              const title = displayTitle(draft.id, draft.defaultTitle);
              const editing = editingId === draft.id;
              return (
                <View key={draft.id} style={styles.row}>
                  <View style={styles.rowText}>
                    {editing ? (
                      <TextInput
                        accessibilityLabel="Sample title"
                        value={editingValue}
                        onChangeText={setEditingValue}
                        onEndEditing={() => commitRename(draft.id)}
                        onSubmitEditing={() => commitRename(draft.id)}
                        maxLength={80}
                        returnKeyType="done"
                        style={styles.rowTitle}
                      />
                    ) : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Open sample ${title}`}
                        onPress={() => setRoute({ name: "sample", id: draft.id })}
                      >
                        <Text style={styles.rowTitle}>{title}</Text>
                      </Pressable>
                    )}
                    <Text style={styles.notesStatus}>
                      {sampleNotesLabel(groundNotes(draft).status)}
                    </Text>
                    <View style={styles.rowActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Rename ${title}`}
                        onPress={() => beginRename(draft.id, title)}
                        style={styles.play}
                      >
                        <Text style={styles.playText}>Rename</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${title}`}
                        onPress={() => setRoute({ name: "sample", id: draft.id })}
                        style={styles.play}
                      >
                        <Text style={styles.playText}>Open</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}
        {recoveryFiles.length > 0 && (
          <View style={styles.libraryHeader}>
            <Text style={styles.section}>Files needing recovery</Text>
            <Text style={styles.body}>These files were kept but are not confirmed as saved audio. Recover checks them; Export lets you keep a separate copy.</Text>
            {recoveryFiles.map((file) => (
              <View key={file.name} style={styles.rowText}>
                <Text style={styles.rowMeta}>{file.name} · {formatFileSize(file.sizeBytes)}</Text>
                {file.canRecover && <Control label="Recover" enabled={!busy} onPress={() => void recoveryAction("recoverFile", file.name)} />}
                <Control label="Export" enabled={!busy} onPress={() => void recoveryAction("exportRecoveryFile", file.name)} />
                <Control label="Delete" enabled={!busy} onPress={() => Alert.alert(
                  "Delete recovery file?", "This permanently deletes this file. Export a copy first if you want to keep it.",
                  [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void recoveryAction("deleteRecoveryFile", file.name) }],
                )} />
              </View>
            ))}
          </View>
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
    return "Audio is saved in sections about every 45 seconds. Small gaps may occur between sections. Keep the recording notification visible.";
  }
  if (visible.state === "paused") {
    if (pausedByFocus) {
      return "Paused while another app uses audio. Tap Pause to stay paused. Otherwise recording resumes when the microphone is free. Paused time is not counted.";
    }
    return "Paused time is not added to the duration.";
  }
  if (visible.state === "interrupted") {
    if (active?.playable) return "The recording was interrupted. Saved sections can still play; unfinished files are kept for recovery.";
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

function recordingFallbackTitle(recording: LocalRecordingRecord): string {
  return `Recording · ${recordingDate(recording.startedAtMs)} · ${recordingTime(recording.startedAtMs)}`;
}

function recordingDate(startedAtMs: number): string {
  return new Date(startedAtMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function recordingTime(startedAtMs: number): string {
  return new Date(startedAtMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function Fact({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, emphasize && styles.factValueAccent]}>
        {value}
      </Text>
    </View>
  );
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
    if (recording.playable) return "Interrupted · saved sections available";
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
  stack: {
    gap: 12,
  },
  backLink: {
    color: theme.accent,
    fontSize: 16,
    fontWeight: "600",
  },
  search: {
    color: theme.text,
    fontSize: 16,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.line,
    backgroundColor: theme.surface,
    paddingHorizontal: 14,
  },
  notesStatus: {
    color: theme.accent,
    fontSize: 14,
    lineHeight: 20,
  },
  rowActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
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
  },
  libraryHeader: {
    marginTop: 20,
    gap: 6,
  },
  storageTotal: {
    color: theme.accent,
    fontSize: 15,
    fontVariant: ["tabular-nums"],
  },
  rowState: {
    color: theme.muted,
    fontSize: 13,
    letterSpacing: 0.4,
  },
  fact: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
  },
  factLabel: {
    color: theme.muted,
    fontSize: 13,
  },
  factValue: {
    color: theme.text,
    fontSize: 16,
    fontVariant: ["tabular-nums"],
  },
  factValueAccent: {
    color: theme.accent,
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

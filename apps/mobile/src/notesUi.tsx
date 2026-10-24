import { useEffect, useState } from "react";
import {
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  NOTES_UPLOAD_EXPLANATION,
  audioPartLabel,
  cleanTitle,
  formatClock,
  formatNotesForShare,
  groundNotes,
  locateAudioSection,
  recordingNotesLabel,
  sectionStartMs,
  type GroundedNotes,
  type NotesDraft,
  type RecordingNotesPhase,
} from "@memoai/shared";
import { theme } from "./theme";

type NotesTab = "summary" | "transcript" | "actions";

type AudioSection = {
  durationMs: number;
};

export function RecordingNotesScreen({
  title,
  onTitle,
  onBack,
  phase,
  parts,
  durationLabel,
  dateLabel,
  sizeLabel,
  incompleteParts,
  onCreateNotes,
  onPlayAt,
  playDisabled,
  playingPart,
  error,
  cloudLabel,
  cloudDetail,
  onSignIn,
  onUpload,
  onCancelCloud,
  onDeleteUpload,
}: {
  title: string;
  onTitle: (next: string | null) => void;
  onBack: () => void;
  phase: RecordingNotesPhase;
  parts: readonly AudioSection[];
  durationLabel: string;
  dateLabel: string;
  sizeLabel: string;
  incompleteParts: number;
  onCreateNotes: () => void;
  onPlayAt: (startMs: number) => void;
  playDisabled: boolean;
  playingPart: number | null;
  error: string | null;
  cloudLabel: string;
  cloudDetail: string;
  onSignIn: () => void;
  onUpload: () => void;
  onCancelCloud: () => void;
  onDeleteUpload: () => void;
}) {
  const [tab, setTab] = useState<NotesTab>("summary");
  return (
    <View style={styles.stack}>
      <BackButton onPress={onBack} />
      <TitleField title={title} onTitle={onTitle} label="Recording title" />
      <Text style={styles.status}>{cloudLabel || recordingNotesLabel(phase)}</Text>
      <Text style={styles.body}>{cloudDetail}</Text>
      {cloudLabel === "Sign in to create notes" ? (
        <PrimaryButton label="Sign in" onPress={onSignIn} />
      ) : null}
      {cloudLabel === "Ready to upload" ? (
        <PrimaryButton label="Upload finished audio" onPress={onUpload} />
      ) : null}
      {cloudLabel === "Uploading" || cloudLabel === "Processing" ? (
        <SecondaryButton label="Cancel" onPress={onCancelCloud} />
      ) : null}
      {cloudLabel === "Notes ready" || cloudLabel === "Partial notes" || cloudLabel === "Notes failed" || cloudLabel === "Notes paused" || cloudLabel === "Upload interrupted" ? (
        <SecondaryButton label="Delete uploaded audio" onPress={onDeleteUpload} />
      ) : null}
      <Text style={styles.meta}>
        {dateLabel} · {durationLabel} · {sizeLabel}
      </Text>
      {incompleteParts > 0 ? (
        <Text style={styles.body}>
          {incompleteParts} section{incompleteParts === 1 ? "" : "s"} unfinished
          or missing. Notes would use finished audio only.
        </Text>
      ) : null}
      {phase === "none" ? (
        <PrimaryButton label="Create notes" onPress={onCreateNotes} />
      ) : null}
      {phase === "not-processed" || phase === "too-long" ? (
        <SecondaryButton
          label={phase === "too-long" ? "Why notes are unavailable" : "Review what would be uploaded"}
          onPress={onCreateNotes}
        />
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TabBar tab={tab} onChange={setTab} />
      {tab === "summary" ? <EmptyNotes phase={phase} kind="summary" /> : null}
      {tab === "transcript" ? (
        <View style={styles.stack}>
          <EmptyNotes phase={phase} kind="transcript" />
          {parts.map((part, index) => {
            const start = sectionStartMs(parts, index);
            const label = audioPartLabel(parts.length, index);
            const playing = playingPart === index + 1;
            return (
              <Pressable
                key={`${index}-${part.durationMs}`}
                accessibilityRole="button"
                accessibilityLabel={label}
                disabled={playDisabled || start == null}
                onPress={() => {
                  if (start != null) {
                    onPlayAt(start);
                  }
                }}
                style={[styles.play, (playDisabled || start == null) && styles.disabled]}
              >
                <Text style={styles.playText}>
                  {playing ? "Playing" : label}
                  {part.durationMs > 0 ? ` · ${formatClock(part.durationMs)}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {tab === "actions" ? <EmptyNotes phase={phase} kind="actions" /> : null}
    </View>
  );
}

export function SampleNotesScreen({
  draft,
  title,
  onTitle,
  onBack,
  doneIds,
  onToggle,
  onShareError,
}: {
  draft: NotesDraft;
  title: string;
  onTitle: (next: string | null) => void;
  onBack: () => void;
  doneIds: readonly string[];
  onToggle: (actionId: string) => void;
  onShareError: (message: string) => void;
}) {
  const notes = groundNotes(draft);
  const [tab, setTab] = useState<NotesTab>("summary");
  const [playNote, setPlayNote] = useState<string | null>(null);
  const shareText = formatNotesForShare(notes, title, doneIds);
  return (
    <View style={styles.stack}>
      <BackButton onPress={onBack} />
      <Text style={styles.sampleBanner}>
        Sample. These notes were not created from a recording on this phone.
      </Text>
      <TitleField title={title} onTitle={onTitle} label="Sample title" />
      <Text style={styles.status}>{sampleStatus(notes)}</Text>
      {notes.missing ? <Text style={styles.body}>{notes.missing}</Text> : null}
      {notes.failureReason ? <Text style={styles.error}>{notes.failureReason}</Text> : null}
      <TabBar tab={tab} onChange={setTab} />
      {tab === "summary" ? (
        <View style={styles.stack}>
          <Text style={styles.section}>Overview</Text>
          {notes.overview.length === 0 ? (
            <Text style={styles.body}>No overview was produced.</Text>
          ) : (
            notes.overview.map((line) => (
              <Text key={line} style={styles.body}>
                {line}
              </Text>
            ))
          )}
          <Text style={styles.section}>Key points</Text>
          {notes.keyPoints.length === 0 ? (
            <Text style={styles.body}>No key points were produced.</Text>
          ) : (
            notes.keyPoints.map((point) => (
              <Text key={point.id} style={styles.body}>
                {point.text}
              </Text>
            ))
          )}
          <DecisionBlock notes={notes} />
          {shareText ? (
            <Text selectable style={styles.copy}>
              {shareText}
            </Text>
          ) : null}
        </View>
      ) : null}
      {tab === "transcript" ? (
        <View style={styles.stack}>
          {playNote ? <Text style={styles.body}>{playNote}</Text> : null}
          {notes.passages.map((passage) => (
            <View key={passage.id} style={styles.card}>
              <Text style={styles.time}>
                {formatClock(passage.startMs)}–{formatClock(passage.endMs)}
              </Text>
              <Text selectable style={styles.body}>
                {passage.text}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Play passage at ${formatClock(passage.startMs)}`}
                onPress={() => setPlayNote(samplePlayMessage(draft, passage.startMs))}
                style={styles.play}
              >
                <Text style={styles.playText}>Play this line</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {tab === "actions" ? (
        notes.status === "failed" ? (
          <Text style={styles.body}>No tasks were created.</Text>
        ) : notes.actions.length === 0 ? (
          <Text style={styles.body}>No task was stated in the transcript.</Text>
        ) : (
          <View style={styles.stack}>
            {notes.actions.map((action) => {
              const done = doneIds.includes(action.id);
              return (
                <Pressable
                  key={action.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: done }}
                  accessibilityLabel={action.text}
                  onPress={() => onToggle(action.id)}
                  style={styles.card}
                >
                  <View style={styles.actionRow}>
                    <View style={[styles.box, done && styles.boxOn]}>
                      {done ? <Text style={styles.boxMark}>✓</Text> : null}
                    </View>
                    <Text style={[styles.body, styles.actionText]}>{action.text}</Text>
                  </View>
                  <Text style={styles.meta}>Owner {action.owner ?? "not set"}</Text>
                  <Text style={styles.meta}>Deadline {action.deadline ?? "not set"}</Text>
                </Pressable>
              );
            })}
          </View>
        )
      ) : null}
      {shareText ? (
        <View style={styles.stack}>
          <Text style={styles.body}>Select the notes on Summary to copy them, or share them.</Text>
          <PrimaryButton
            label="Share notes"
            onPress={() => {
              void Share.share({ message: shareText }).catch((shareError: unknown) => {
                onShareError(shareError instanceof Error ? shareError.message : "Sharing failed.");
              });
            }}
          />
        </View>
      ) : (
        <Text style={styles.body}>
          {notes.status === "failed"
            ? "These notes cannot be shared."
            : "Sharing waits until the notes are complete."}
        </Text>
      )}
    </View>
  );
}

export function AccountScreen({
  configured,
  email,
  onBack,
  onSignIn,
  onCreateAccount,
  onSignOut,
  error,
}: {
  configured: boolean;
  email: string | null;
  onBack: () => void;
  onSignIn: (email: string, password: string) => void;
  onCreateAccount: (email: string, password: string) => void;
  onSignOut: () => void;
  error: string | null;
}) {
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  return (
    <View style={styles.stack}>
      <BackButton onPress={onBack} />
      <Text style={styles.heading}>Account</Text>
      <Text style={styles.body}>
        Recording works with no account. Sign in only when you want finished audio uploaded for notes.
        The service-role key stays off this phone.
      </Text>
      {email ? <Text style={styles.status}>{email}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!configured ? (
        <Text style={styles.body}>
          Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to the phone build.
          No audio is uploaded until those are set and you agree.
        </Text>
      ) : email ? (
        <SecondaryButton label="Sign out" onPress={onSignOut} />
      ) : (
        <View style={styles.stack}>
          <TextInput
            accessibilityLabel="Email"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={address}
            onChangeText={setAddress}
            placeholder="Email"
            placeholderTextColor={theme.muted}
            style={styles.titleInput}
          />
          <TextInput
            accessibilityLabel="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={theme.muted}
            style={styles.titleInput}
          />
          <PrimaryButton label="Sign in" onPress={() => onSignIn(address.trim(), password)} />
          <SecondaryButton label="Create account" onPress={() => onCreateAccount(address.trim(), password)} />
        </View>
      )}
    </View>
  );
}

export function ConsentScreen({
  allowAgree,
  alreadySaved,
  blockedReason,
  onAgree,
  onBack,
}: {
  allowAgree: boolean;
  alreadySaved: boolean;
  blockedReason: string | null;
  onAgree: () => void;
  onBack: () => void;
}) {
  const copy = NOTES_UPLOAD_EXPLANATION;
  return (
    <View style={styles.stack}>
      <BackButton onPress={onBack} />
      <Text style={styles.heading}>{copy.title}</Text>
      <Text style={styles.body}>{copy.intro}</Text>
      <Text style={styles.section}>{copy.leavesTitle}</Text>
      <Text style={styles.body}>{copy.leaves}</Text>
      <Text style={styles.section}>{copy.whyTitle}</Text>
      <Text style={styles.body}>{copy.why}</Text>
      <Text style={styles.section}>{copy.staysTitle}</Text>
      <Text style={styles.body}>{copy.stays}</Text>
      <Text style={styles.section}>{copy.notYetTitle}</Text>
      <Text style={styles.body}>{copy.notYet}</Text>
      {alreadySaved ? <Text style={styles.status}>{copy.saved}</Text> : null}
      {blockedReason ? <Text style={styles.error}>{blockedReason}</Text> : null}
      {allowAgree && !alreadySaved ? (
        <PrimaryButton label={copy.agree} onPress={onAgree} />
      ) : null}
      <SecondaryButton label={alreadySaved ? "Back to the recording" : copy.decline} onPress={onBack} />
    </View>
  );
}

function DecisionBlock({ notes }: { notes: GroundedNotes }) {
  if (notes.status === "failed") {
    return null;
  }
  return (
    <View style={styles.stack}>
      <Text style={styles.section}>Decisions</Text>
      {notes.decisions.length === 0 ? (
        <Text style={styles.body}>No decision was stated in the transcript.</Text>
      ) : (
        notes.decisions.map((decision) => (
          <Text key={decision.id} style={styles.body}>
            {decision.text}
          </Text>
        ))
      )}
    </View>
  );
}

function EmptyNotes({
  phase,
  kind,
}: {
  phase: RecordingNotesPhase;
  kind: NotesTab;
}) {
  if (phase === "not-processed") {
    return <Text style={styles.body}>{NOTES_UPLOAD_EXPLANATION.saved}</Text>;
  }
  if (phase === "live") {
    return <Text style={styles.body}>Stop the recording before creating notes.</Text>;
  }
  if (phase === "no-audio") {
    return <Text style={styles.body}>There is no finished audio to transcribe.</Text>;
  }
  if (phase === "too-long") {
    return (
      <Text style={styles.body}>
        This recording is longer than 90 minutes, so notes are not created.
      </Text>
    );
  }
  if (kind === "summary") {
    return <Text style={styles.body}>No summary yet.</Text>;
  }
  if (kind === "actions") {
    return <Text style={styles.body}>No action items yet.</Text>;
  }
  return (
    <Text style={styles.body}>
      No transcript yet. After you agree, each line can play its audio section.
      Nothing is uploaded from this screen.
    </Text>
  );
}

function samplePlayMessage(draft: NotesDraft, startMs: number): string {
  const parts = draft.sectionDurationMs.map((durationMs) => ({ durationMs }));
  const located = locateAudioSection(parts, startMs);
  if (!located) {
    return "That time is past the sample map. Nothing was played.";
  }
  const place =
    parts.length <= 1
      ? `the audio file at ${formatClock(located.offsetMs)}`
      : `section ${located.partIndex + 1} at ${formatClock(located.offsetMs)}`;
  return `Sample has no audio. This line maps to ${place}. Nothing was played.`;
}

function sampleStatus(notes: GroundedNotes): string {
  if (notes.status === "ready") {
    return "Sample · notes complete";
  }
  if (notes.status === "partial") {
    return "Sample · partial notes";
  }
  return "Sample · failed";
}

function TitleField({
  title,
  onTitle,
  label,
}: {
  title: string;
  onTitle: (next: string | null) => void;
  label: string;
}) {
  const [value, setValue] = useState(title);
  useEffect(() => {
    setValue(title);
  }, [title]);
  return (
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={setValue}
      onEndEditing={() => onTitle(cleanTitle(value))}
      onSubmitEditing={() => onTitle(cleanTitle(value))}
      maxLength={80}
      returnKeyType="done"
      placeholder="Title"
      placeholderTextColor={theme.muted}
      style={styles.titleInput}
    />
  );
}

function TabBar({
  tab,
  onChange,
}: {
  tab: NotesTab;
  onChange: (tab: NotesTab) => void;
}) {
  const items: { id: NotesTab; label: string }[] = [
    { id: "summary", label: "Summary" },
    { id: "transcript", label: "Transcript" },
    { id: "actions", label: "Actions" },
  ];
  return (
    <View style={styles.tabs}>
      {items.map((item) => {
        const selected = tab === item.id;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(item.id)}
            style={[styles.tab, selected && styles.tabOn]}
          >
            <Text style={[styles.tabText, selected && styles.tabTextOn]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back to library" onPress={onPress} style={styles.back}>
      <Text style={styles.backText}>Library</Text>
    </Pressable>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.primary}>
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.secondary}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: 12,
  },
  back: {
    alignSelf: "flex-start",
    minHeight: 44,
    justifyContent: "center",
  },
  backText: {
    color: theme.accent,
    fontSize: 16,
    fontWeight: "600",
  },
  sampleBanner: {
    color: theme.accent,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
  },
  heading: {
    color: theme.text,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: "600",
  },
  titleInput: {
    color: theme.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "600",
    paddingVertical: 4,
  },
  status: {
    color: theme.accent,
    fontSize: 16,
    lineHeight: 22,
  },
  meta: {
    color: theme.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  body: {
    color: theme.muted,
    fontSize: 16,
    lineHeight: 24,
  },
  copy: {
    color: theme.text,
    fontSize: 15,
    lineHeight: 22,
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 16,
  },
  error: {
    color: theme.dangerText,
    fontSize: 16,
    lineHeight: 22,
  },
  section: {
    color: theme.text,
    fontSize: 13,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginTop: 8,
  },
  tabs: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  tab: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.line,
  },
  tabOn: {
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  tabText: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "600",
  },
  tabTextOn: {
    color: "#1A140C",
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: theme.line,
  },
  time: {
    color: theme.accent,
    fontSize: 14,
    fontVariant: ["tabular-nums"],
  },
  play: {
    minHeight: 44,
    borderRadius: 999,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.line,
  },
  playText: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.35,
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
  },
  actionText: {
    flex: 1,
    color: theme.text,
  },
  box: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: {
    backgroundColor: theme.accent,
  },
  boxMark: {
    color: "#1A140C",
    fontSize: 16,
    fontWeight: "700",
  },
  primary: {
    backgroundColor: theme.accent,
    borderRadius: 16,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryText: {
    color: "#1A140C",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  secondary: {
    borderRadius: 16,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.line,
    paddingHorizontal: 16,
  },
  secondaryText: {
    color: theme.text,
    fontSize: 16,
    textAlign: "center",
  },
});

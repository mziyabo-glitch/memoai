import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  cleanTitle,
  notesConsentRecord,
  type NotesConsentRecord,
} from "@memoai/shared";

const TITLES_KEY = "memoai.recordingTitles.v1";
const CONSENT_KEY = "memoai.notesConsent.v1";

export async function loadTitles(): Promise<Record<string, string>> {
  return sanitizeTitles(await AsyncStorage.getItem(TITLES_KEY));
}

export async function saveTitle(
  id: string,
  title: string | null,
): Promise<Record<string, string>> {
  const current = await loadTitles();
  const cleaned = title == null ? null : cleanTitle(title);
  if (cleaned == null) {
    delete current[id];
  } else {
    current[id] = cleaned;
  }
  await AsyncStorage.setItem(TITLES_KEY, JSON.stringify(current));
  return current;
}

export async function loadConsents(): Promise<Record<string, NotesConsentRecord>> {
  return sanitizeConsents(await AsyncStorage.getItem(CONSENT_KEY));
}

export async function saveConsent(
  recordingId: string,
  agreedAt: string,
): Promise<Record<string, NotesConsentRecord>> {
  const current = await loadConsents();
  current[recordingId] = notesConsentRecord(recordingId, agreedAt);
  await AsyncStorage.setItem(CONSENT_KEY, JSON.stringify(current));
  return current;
}

function sanitizeTitles(raw: string | null): Record<string, string> {
  const parsed = parseObject(raw);
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      continue;
    }
    const cleaned = cleanTitle(value);
    if (cleaned) {
      result[id] = cleaned;
    }
  }
  return result;
}

function sanitizeConsents(raw: string | null): Record<string, NotesConsentRecord> {
  const parsed = parseObject(raw);
  const result: Record<string, NotesConsentRecord> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const record = value as Partial<NotesConsentRecord>;
    if (
      record.version !== 1 ||
      record.recordingId !== id ||
      record.explanationVersion !== 1 ||
      record.uploaded !== false ||
      record.providerCalled !== false ||
      typeof record.agreedAt !== "string"
    ) {
      continue;
    }
    result[id] = notesConsentRecord(id, record.agreedAt);
  }
  return result;
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "memoai.participantNotice.v1";

type StoredNotice = {
  version: 1;
  acknowledgedAt: string;
};

export async function hasAcknowledgedParticipantNotice(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredNotice>;
    return parsed.version === 1 && typeof parsed.acknowledgedAt === "string";
  } catch {
    return false;
  }
}

export async function acknowledgeParticipantNotice(): Promise<void> {
  const record: StoredNotice = {
    version: 1,
    acknowledgedAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(record));
}

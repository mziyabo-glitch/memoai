import { PermissionsAndroid, Platform } from "react-native";

function androidApiLevel(): number {
  return typeof Platform.Version === "number"
    ? Platform.Version
    : Number(Platform.Version);
}

export type CapturePermission = {
  microphone: boolean;
  notifications: boolean;
};

export async function readCapturePermission(): Promise<CapturePermission> {
  const microphone = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  );
  const notifications =
    androidApiLevel() >= 33
      ? await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        )
      : true;
  return { microphone, notifications };
}

export function capturePermissionGranted(permission: CapturePermission): boolean {
  return permission.microphone && permission.notifications;
}

/**
 * Call only after the in-app explanation. This is the system prompt.
 */
export async function requestCapturePermission(): Promise<CapturePermission> {
  const microphone = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  );
  let notificationsGranted = true;
  if (androidApiLevel() >= 33) {
    const notifications = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    notificationsGranted =
      notifications === PermissionsAndroid.RESULTS.GRANTED;
  }
  return {
    microphone: microphone === PermissionsAndroid.RESULTS.GRANTED,
    notifications: notificationsGranted,
  };
}

#!/usr/bin/env bash
# Confirm the merged app manifest registered the recorder with fully
# qualified class names. A relative android:name is prefixed with the
# application package and would not match the Kotlin classes.
set -euo pipefail

root="${1:-apps/mobile/android}"
service='android:name="expo.modules.memoairecorder.MemoAiRecorderService"'
receiver='android:name="expo.modules.memoairecorder.StopRecordingReceiver"'

if [[ ! -d "$root" ]]; then
  echo "Android project not found at $root" >&2
  exit 1
fi

mapfile -t manifests < <(find "$root" -path '*merged_manifest*' -name AndroidManifest.xml | sort)
if [[ ${#manifests[@]} -eq 0 ]]; then
  echo "No merged AndroidManifest.xml under $root" >&2
  exit 1
fi

app_manifest=""
for manifest in "${manifests[@]}"; do
  if [[ "$manifest" == *"/app/build/"* ]]; then
    app_manifest="$manifest"
    break
  fi
done

if [[ -z "$app_manifest" ]]; then
  echo "No app merged manifest among:" >&2
  printf '  %s\n' "${manifests[@]}" >&2
  exit 1
fi

echo "Checking $app_manifest"
text="$(<"$app_manifest")"

fail() {
  echo "$1" >&2
  exit 1
}

if [[ "$text" != *"$service"* ]]; then
  fail "Merged manifest is missing $service"
fi
if [[ "$text" != *"$receiver"* ]]; then
  fail "Merged manifest is missing $receiver"
fi
if [[ "$text" != *'android:foregroundServiceType="microphone"'* ]]; then
  fail "Merged manifest is missing microphone foreground service type"
fi
if [[ "$text" == *'com.memoai.app.MemoAiRecorderService'* ]]; then
  fail "Service class was prefixed with the application package"
fi
if [[ "$text" == *'com.memoai.app.StopRecordingReceiver'* ]]; then
  fail "Receiver class was prefixed with the application package"
fi
if [[ "$text" == *'android:name=".MemoAiRecorderService"'* ]]; then
  fail "Service class is still a relative name"
fi
if [[ "$text" == *'android:name=".StopRecordingReceiver"'* ]]; then
  fail "Receiver class is still a relative name"
fi
if [[ "$text" == *'expo.modules.memoairecorder.expo.modules.memoairecorder'* ]]; then
  fail "Class name was double-prefixed"
fi

python3 - "$app_manifest" <<'PY'
import sys
import xml.etree.ElementTree as ET

path = sys.argv[1]
tree = ET.parse(path)
application = tree.getroot().find("application")
allow_backup = "{http://schemas.android.com/apk/res/android}allowBackup"
if application is None or application.attrib.get(allow_backup) != "false":
    sys.exit("private recordings require application android:allowBackup=false")
ns = {"android": "http://schemas.android.com/apk/res/android"}
name = "{http://schemas.android.com/apk/res/android}name"
exported = "{http://schemas.android.com/apk/res/android}exported"
service_name = "expo.modules.memoairecorder.MemoAiRecorderService"
receiver_name = "expo.modules.memoairecorder.StopRecordingReceiver"

services = [
    node for node in tree.iter("service") if node.attrib.get(name) == service_name
]
receivers = [
    node for node in tree.iter("receiver") if node.attrib.get(name) == receiver_name
]
if len(services) != 1:
    sys.exit(f"expected one {service_name}, found {len(services)}")
if len(receivers) != 1:
    sys.exit(f"expected one {receiver_name}, found {len(receivers)}")
if services[0].attrib.get(exported) != "false":
    sys.exit("recorder service must be exported=false")
if receivers[0].attrib.get(exported) != "false":
    sys.exit("stop receiver must be exported=false")
print("Merged manifest class names are fully qualified.")
PY

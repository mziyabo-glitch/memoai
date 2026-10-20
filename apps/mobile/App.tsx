import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { RecorderScreen } from "./src/RecorderScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <RecorderScreen />
    </SafeAreaProvider>
  );
}

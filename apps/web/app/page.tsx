export default function HomePage() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "72px 24px 96px",
      }}
    >
      <p
        style={{
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontSize: 13,
          color: "#e7c59a",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        MemoAI
      </p>
      <h1
        style={{
          fontSize: "clamp(40px, 6vw, 64px)",
          lineHeight: 1.05,
          fontWeight: 560,
          margin: "16px 0 20px",
        }}
      >
        Meetings, recorded on your phone.
      </h1>
      <p style={{ fontSize: 20, lineHeight: 1.5, color: "#c8c1b6", margin: 0 }}>
        MemoAI records on Android and keeps the audio on the device. No account
        is required to record. This site does not record audio.
      </p>
      <p
        style={{
          marginTop: 28,
          fontSize: 16,
          lineHeight: 1.6,
          color: "#9a9388",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        Install the Android development build to use the recorder. Cloud
        projects for Supabase and this website are optional and are not used
        while you record.
      </p>
    </main>
  );
}

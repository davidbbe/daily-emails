export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        fontFamily: "Georgia, serif",
        background:
          "radial-gradient(circle at top left, #e8f0ea, transparent 45%), linear-gradient(160deg, #f7f4ef, #dfe8e3)",
        color: "#1a1f1c",
      }}
    >
      <div style={{ maxWidth: 560 }}>
        <p style={{ letterSpacing: "0.08em", textTransform: "uppercase", fontSize: 12, margin: 0 }}>
          Agent Dave
        </p>
        <h1 style={{ fontSize: "2.4rem", lineHeight: 1.15, margin: "0.4rem 0 1rem" }}>
          Daily market &amp; tech brief
        </h1>
        <p style={{ fontSize: "1.1rem", lineHeight: 1.6, margin: 0 }}>
          A Vercel cron job researches markets, people, catalysts, and web
          trends across the US, Thailand, and Bulgaria — then emails a noon-UTC
          digest with flags, quotes, day-over-day movers, and source links via
          Resend.
        </p>
        <p style={{ marginTop: "1.5rem", color: "#445048", fontSize: "0.95rem" }}>
          Endpoint: <code>/api/daily-brief</code> · Schedule: <code>0 12 * * *</code> UTC
        </p>
      </div>
    </main>
  );
}

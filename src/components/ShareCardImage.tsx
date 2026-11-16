import type { ShareCard } from "@/lib/share-links";

// The 1200×630 card Instagram DMs, WhatsApp, Google and X show for a host's link. Drawn by next/og (Satori): flexbox
// only, inline styles, and the light-theme values of the brand tokens since an image can't read CSS variables.
const C = { bg: "#fffdf8", text: "#1f1a14", muted: "#62584b", accent: "#b4410e", surface: "#f5efe4", border: "#e7dccb" };

export function ShareCardImage({ card }: { card: ShareCard }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "64px 72px", background: C.bg, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
        {card.photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- Satori draws <img>, not next/image
          <img src={card.photo} width={184} height={184} alt="" style={{ width: 184, height: 184, borderRadius: 92, objectFit: "cover", border: `6px solid ${C.surface}` }} />
        ) : (
          <div style={{ width: 184, height: 184, borderRadius: 92, background: C.accent, color: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 72, fontWeight: 700 }}>
            {card.initials}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.05 }}>{card.name}</div>
          {card.headline && <div style={{ marginTop: 14, fontSize: 32, color: C.text, lineHeight: 1.25 }}>{card.headline}</div>}
          {card.area && <div style={{ marginTop: 10, fontSize: 26, color: C.muted }}>{card.area}</div>}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 40, flex: 1 }}>
        {card.services.map((s) => (
          <div key={s.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", borderRadius: 14, background: C.surface, border: `2px solid ${C.border}`, fontSize: 28 }}>
            <div style={{ display: "flex", fontWeight: 700 }}>{s.name}</div>
            <div style={{ display: "flex", color: C.muted }}>{s.detail}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, fontSize: 28 }}>
        <div style={{ display: "flex", color: C.muted }}>{card.link}</div>
        <div style={{ display: "flex", padding: "12px 28px", borderRadius: 999, background: C.accent, color: C.bg, fontWeight: 700 }}>Book a time</div>
      </div>
    </div>
  );
}

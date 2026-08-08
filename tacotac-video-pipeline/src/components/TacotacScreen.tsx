import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { app, brand, fonts, toneMeta } from "../theme";
import type { TacotacBeat } from "../schema";

const foxByTone: Record<string, string> = {
  classe: "tacotac/fox_classe.png",
  drole: "tacotac/fox_chill.png",
  spicy: "tacotac/fox_spicy.png",
  romantique: "tacotac/fox_chill.png",
  sexto: "tacotac/fox_chill.png",
  mystere: "tacotac/fox_chill.png",
};

const allTones = ["classe", "drole", "spicy", "romantique", "sexto", "mystere"] as const;

// Recréation fidèle de l'écran "Tes répliques" de l'app réelle (tacotac-app/public/app.html).
// C'est un cutaway plein écran (screen recording de l'app), pas une carte inline dans la conv.
export const TacotacScreen: React.FC<{ beat: TacotacBeat }> = ({ beat }) => {
  const meta = toneMeta[beat.tone];
  const fox = foxByTone[beat.tone];

  return (
    <AbsoluteFill style={{ background: app.bg, padding: "48px 44px" }}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: 28,
          borderBottom: `1px solid ${app.headerBorder}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              overflow: "hidden",
              background: "#1a1a1a",
              border: `2px solid ${app.avatarBorder}`,
            }}
          >
            <Img
              src={staticFile("tacotac/fox_chill.png")}
              style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 3%" }}
            />
          </div>
          <span style={{ fontFamily: fonts.body, fontWeight: 700, fontSize: 34, color: "#fff", letterSpacing: -0.5 }}>
            Tes répliques
          </span>
        </div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            fontFamily: fonts.body,
            fontWeight: 600,
            fontSize: 26,
            color: app.badgePillText,
            border: `1px solid ${app.badgePillBorder}`,
            background: app.badgePillBg,
            borderRadius: 100,
            padding: "12px 24px",
          }}
        >
          {meta.emoji} Mode {meta.label}
        </div>
      </div>

      {/* tone selector */}
      <div style={{ marginTop: 40 }}>
        <div
          style={{
            fontFamily: fonts.body,
            fontSize: 22,
            letterSpacing: 1,
            textTransform: "uppercase",
            fontWeight: 500,
            color: "#6e6a66",
            marginBottom: 18,
          }}
        >
          Choisis ton ton
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {allTones.map((tone) => {
            const m = toneMeta[tone];
            const active = tone === beat.tone;
            return (
              <div
                key={tone}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  padding: "22px 10px",
                  borderRadius: 24,
                  border: `2px solid ${active ? app.pillActiveBorder : app.pillBorder}`,
                  background: active ? app.pillActiveBg : app.pillBg,
                  opacity: m.locked ? 0.55 : 1,
                }}
              >
                <span style={{ fontSize: 36 }}>{m.emoji}</span>
                <span
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 24,
                    fontWeight: 600,
                    color: active ? "#fff" : app.pillLabel,
                  }}
                >
                  {m.label}
                  {m.locked ? " 🔒" : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* result card */}
      <div
        style={{
          marginTop: 32,
          background: app.resultCardBg,
          border: `1px solid ${app.resultCardBorder}`,
          borderRadius: 36,
          padding: 34,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, color: "#fff", fontFamily: fonts.body, fontSize: 28, fontWeight: 600 }}>
            <span style={{ fontSize: 32 }}>{meta.emoji}</span> Ton {meta.label}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: app.refaireBg,
              border: `1px solid ${app.refaireBorder}`,
              borderRadius: 100,
              padding: "12px 22px",
              color: app.refaireText,
              fontFamily: fonts.body,
              fontSize: 22,
              fontWeight: 500,
            }}
          >
            Refaire ↻
          </div>
        </div>

        <div
          style={{
            marginTop: 28,
            position: "relative",
            background: app.bubbleBg,
            border: `1px solid ${app.bubbleBorder}`,
            borderRadius: 30,
            padding: "26px 30px",
          }}
        >
          <div
            style={{
              fontFamily: fonts.body,
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: app.labelOrange,
              marginBottom: 14,
            }}
          >
            Tiens réponds lui ça
          </div>
          <div style={{ fontFamily: fonts.body, fontSize: 32, fontWeight: 500, lineHeight: 1.5, color: app.replyText }}>
            {beat.text}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
          <Img src={staticFile(fox)} style={{ height: 220, objectFit: "contain" }} />
        </div>
      </div>

      <div
        style={{
          marginTop: 28,
          width: "100%",
          background: brand.orange,
          borderRadius: 26,
          padding: "26px",
          textAlign: "center",
          fontFamily: fonts.body,
          fontWeight: 700,
          fontSize: 30,
          color: "#fff",
        }}
      >
        📋 Copier la réponse
      </div>
    </AbsoluteFill>
  );
};

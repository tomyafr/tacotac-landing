import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile } from "remotion";
import { fonts } from "../theme";

// Les GIFs sont convertis en mp4 en amont (voir public/memes) — le composant
// <Gif> de Remotion scintille au rendu, on ne l'utilise nulle part dans le projet.
const videoExts = [".mp4", ".mov", ".webm"];
const isVideo = (p: string) => videoExts.some((e) => p.toLowerCase().endsWith(e));

const Background: React.FC<{ src: string }> = ({ src }) => {
  const file = staticFile(src);
  const fill: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
  if (isVideo(src)) return <OffthreadVideo src={file} muted style={fill} />;
  return <Img src={file} style={fill} />;
};

// Hook d'ouverture (grande photo de la fille + titre accrocheur en haut) et CTA
// de fin (gros texte centré). variant règle placement + taille.
export const CaptionCard: React.FC<{
  text: string;
  background: string;
  variant?: "hook" | "outro";
}> = ({ text, background, variant = "hook" }) => {
  const isOutro = variant === "outro";
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Background src={background} />
      {/* voile pour la lisibilité du texte */}
      <AbsoluteFill
        style={{
          background: isOutro
            ? "linear-gradient(0deg, rgba(0,0,0,.55), rgba(0,0,0,.25) 45%, rgba(0,0,0,.55))"
            : "linear-gradient(180deg, rgba(0,0,0,.6), rgba(0,0,0,.05) 42%)",
        }}
      />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: isOutro ? "center" : "flex-start",
          padding: isOutro ? "0 70px" : "150px 60px 0",
        }}
      >
        <div
          style={{
            fontFamily: fonts.title,
            fontWeight: 800,
            fontSize: isOutro ? 92 : 68,
            lineHeight: 1.08,
            color: "#fff",
            textAlign: "center",
            letterSpacing: -1,
            textShadow: "0 3px 22px rgba(0,0,0,.75)",
          }}
        >
          {text}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

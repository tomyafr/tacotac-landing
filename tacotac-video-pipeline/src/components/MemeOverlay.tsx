import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile } from "remotion";
import { fonts } from "../theme";

const videoExts = [".mp4", ".mov", ".webm"];
const isVideo = (p: string) => videoExts.some((e) => p.toLowerCase().endsWith(e));

// Cutaway meme plein écran. Supporte clip vidéo (memes ex-GIF convertis en mp4 —
// le composant <Gif> de Remotion scintille au rendu, on évite) ou image fixe.
// Affiché en `contain` (letterbox centré) comme dans les vraies vidéos — le meme
// n'est jamais croppé. Un clip plus court que le beat se fige sur sa dernière frame.
//
// `caption` : texte optionnel incrusté en bas (ex: "laisse moi cook"), choisi par
// le CODE en rotation — voir memeBeat.caption dans schema.ts. La plupart des
// memes n'en ont pas ; utilisé pour l'instant sur le meme "avant DM".
export const MemeOverlay: React.FC<{ asset: string; caption?: string }> = ({ asset, caption }) => {
  const src = staticFile(asset);
  const fill: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  };
  return (
    <AbsoluteFill style={{ background: "#000", justifyContent: "center", alignItems: "center" }}>
      {isVideo(asset) ? (
        <OffthreadVideo src={src} muted style={fill} />
      ) : (
        <Img src={src} style={fill} />
      )}
      {caption && (
        <>
          {/* voile pour la lisibilité, même logique que Intro.tsx mais en bas */}
          <AbsoluteFill
            style={{ background: "linear-gradient(0deg, rgba(0,0,0,.75), rgba(0,0,0,0) 45%)" }}
          />
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", padding: "0 60px 9%" }}>
            <div
              style={{
                fontFamily: fonts.title,
                fontWeight: 800,
                fontSize: 58,
                lineHeight: 1.12,
                color: "#fff",
                textAlign: "center",
                letterSpacing: -0.6,
                textShadow: "0 3px 22px rgba(0,0,0,.8)",
              }}
            >
              {caption}
            </div>
          </AbsoluteFill>
        </>
      )}
    </AbsoluteFill>
  );
};

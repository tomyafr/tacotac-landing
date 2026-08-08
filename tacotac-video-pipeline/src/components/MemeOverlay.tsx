import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile } from "remotion";

const videoExts = [".mp4", ".mov", ".webm"];
const isVideo = (p: string) => videoExts.some((e) => p.toLowerCase().endsWith(e));

// Cutaway meme plein écran. Supporte clip vidéo (memes ex-GIF convertis en mp4 —
// le composant <Gif> de Remotion scintille au rendu, on évite) ou image fixe.
// Affiché en `contain` (letterbox centré) comme dans les vraies vidéos — le meme
// n'est jamais croppé. Un clip plus court que le beat se fige sur sa dernière frame.
export const MemeOverlay: React.FC<{ asset: string }> = ({ asset }) => {
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
    </AbsoluteFill>
  );
};

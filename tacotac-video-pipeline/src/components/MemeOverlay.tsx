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
// `caption` : texte optionnel incrusté au centre (ex: "laisse moi cook 🔥"),
// choisi par le CODE en rotation — voir memeBeat.caption dans schema.ts. La
// plupart des memes n'en ont pas ; utilisé pour l'instant sur le meme "avant DM".
// Gros et centré (demande Tom du 08/09 : trop discret en bas). Le voile plein
// écran (au lieu du dégradé du bas) garde le texte lisible même au milieu de
// l'image. `titleEmoji` = même police que le reste + fallback couleur pour
// l'emoji (voir theme.ts / fonts.ts) — sinon carré vide sur le VPS de rendu.
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
          <AbsoluteFill style={{ background: "rgba(0,0,0,.45)" }} />
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: "0 56px" }}>
            <div
              style={{
                fontFamily: fonts.titleEmoji,
                fontWeight: 800,
                fontSize: 86,
                lineHeight: 1.08,
                color: "#fff",
                textAlign: "center",
                letterSpacing: -0.8,
                textShadow: "0 4px 26px rgba(0,0,0,.85)",
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

import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { fonts, app, video } from "../theme";
import type { TacotacBeat, Tone } from "../schema";
import { TacotacScreen } from "./TacotacScreen";
import { renderMaskedText } from "./maskedText";

// Approche screenshot : on affiche le VRAI screen de l'app (un par mode) et on
// écrit la réponse générée par-dessus, dans la boîte "tiens réponds lui ça".
// Les screens ont un placeholder "testttt..." sur 3 lignes qui a servi à caler la
// géométrie ci-dessous. On recouvre ce placeholder d'un aplat #1C1C1C (couleur exacte
// de la boîte, échantillonnée), puis on dessine le texte à taille fixe.

const SCREENSHOT_TONES: Tone[] = [
  "classe",
  "drole",
  "spicy",
  "romantique",
  "sexto",
  "mystere",
];

const screenshotFor = (tone: Tone) => `tacotac/test_3_lignes_mode_${tone}.png`;

// Dimensions natives des screenshots (identiques sur les 6).
const NATIVE = { w: 537, h: 952 };

// Géométrie mesurée en pixels natifs sur le screenshot (bulle intérieure x41→494,
// y360→485). L'aplat reste STRICTEMENT dans la bulle (jamais de débordement gris)
// et le texte wrappe dans la même largeur que l'app.
const COVER = { x: 44, y: 389, w: 449, h: 93, radius: 12 };
const TEXT = { x: 56, y: 394, w: 437, fontSize: 18, lineHeight: 1.5 };

export const TacotacScreenshot: React.FC<{ beat: TacotacBeat }> = ({ beat }) => {
  // Fallback : mode sans screenshot → repro native.
  if (!SCREENSHOT_TONES.includes(beat.tone)) {
    return <TacotacScreen beat={beat} />;
  }

  // On remplit la largeur du cadre ; le screen est quasi 9:16 donc léger letterbox vertical.
  const scale = video.width / NATIVE.w;
  const scaledH = NATIVE.h * scale;
  const topOffset = (video.height - scaledH) / 2;

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <div
        style={{
          position: "absolute",
          top: topOffset,
          left: 0,
          width: NATIVE.w,
          height: NATIVE.h,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <Img
          src={staticFile(screenshotFor(beat.tone))}
          style={{ width: NATIVE.w, height: NATIVE.h, display: "block" }}
        />
        {/* aplat qui masque le placeholder "testttt" — inséré dans la bulle */}
        <div
          style={{
            position: "absolute",
            left: COVER.x,
            top: COVER.y,
            width: COVER.w,
            height: COVER.h,
            background: app.bubbleBg,
            borderRadius: COVER.radius,
          }}
        />
        {/* la vraie réponse — taille fixe quelle que soit sa longueur */}
        <div
          style={{
            position: "absolute",
            left: TEXT.x,
            top: TEXT.y,
            width: TEXT.w,
            fontFamily: fonts.body,
            fontSize: TEXT.fontSize,
            fontWeight: 500,
            lineHeight: TEXT.lineHeight,
            color: app.replyText,
          }}
        >
          {renderMaskedText(beat.text)}
        </div>
      </div>
    </AbsoluteFill>
  );
};

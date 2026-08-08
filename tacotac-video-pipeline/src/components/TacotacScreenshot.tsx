import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { fonts, app, video } from "../theme";
import type { TacotacBeat, Tone } from "../schema";
import { TacotacScreen } from "./TacotacScreen";
import { renderMaskedText } from "./maskedText";

// Approche screenshot : on affiche le VRAI screen de l'app (un par outil ET par ton)
// et on écrit la réponse générée par-dessus, dans la bulle. Les screens ont un
// placeholder "testttt..." sur 3 lignes qui sert à caler la géométrie : on le
// recouvre d'un aplat de la couleur exacte de la bulle, puis on dessine le texte.
//
// Screens pris sur iPhone (1179 px de large = 393 pt @3x). Toute la géométrie
// ci-dessous est donc en pixels de screenshot, soit 3× les valeurs CSS de l'app.
// Mesurée automatiquement sur les 8 images (détection du placeholder blanc) :
//   - bulle intérieure : x 126 → 1052
//   - texte : démarre à x=179, interligne 75-77 px, 3 lignes
//   - le haut du texte varie de ~10 px d'une capture à l'autre (scroll pas
//     exactement identique) → on stocke la valeur mesurée POUR CHAQUE image.
const SHOT_W = 1179;

// app.html : .bubble .reply { font-size:16.5px; line-height:1.55 } → ×3
const FONT_SIZE = 16.5 * 3;
const LINE_HEIGHT = 1.55;

const BUBBLE = { left: 126, right: 1052 };
const TEXT_LEFT = 179;
// Décalage entre le haut de la ligne CSS et le haut de l'encre mesurée
// (demi-interligne + écart ascendante/hauteur de capitale).
const INK_OFFSET = 27;

type Shot = { file: string; h: number; inkTop: number };

// inkTop = haut de la 1re ligne du placeholder, mesuré image par image.
const SHOTS: Record<string, Shot> = {
  "dm-classe": { file: "tacotac/dm-classe.png", h: 2270, inkTop: 1154 },
  "dm-spicy": { file: "tacotac/dm-spicy.png", h: 2252, inkTop: 1149 },
  "dm-sexto": { file: "tacotac/dm-sexto.png", h: 2252, inkTop: 1154 },
  "dm-romantique": { file: "tacotac/dm-romantique.png", h: 2271, inkTop: 1158 },
  "reply-classe": { file: "tacotac/rep-classe.png", h: 2283, inkTop: 1153 },
  "reply-spicy": { file: "tacotac/rep-spicy.png", h: 2262, inkTop: 1157 },
  "reply-sexto": { file: "tacotac/rep-sexto.png", h: 2283, inkTop: 1151 },
  "reply-romantique": { file: "tacotac/rep-romantique.png", h: 2259, inkTop: 1148 },
};

// Tons réellement disponibles en screenshot (les vidéos n'utilisent que ceux-là).
const SHOT_TONES: Tone[] = ["classe", "spicy", "sexto", "romantique"];

export const TacotacScreenshot: React.FC<{ beat: TacotacBeat }> = ({ beat }) => {
  const tool = beat.tool === "dm" ? "dm" : "reply";
  const shot = SHOTS[`${tool}-${beat.tone}`];

  // Ton sans screenshot (drôle, mystère) → repro native, jamais de rendu cassé.
  if (!shot || !SHOT_TONES.includes(beat.tone)) {
    return <TacotacScreen beat={beat} />;
  }

  // On remplit la largeur du cadre. Le screen est plus haut que le 9:16, donc il
  // faut rogner : on cale en HAUT (topOffset = 0) pour garder tout l'en-tête
  // ("Tes DM" / "Tes répliques", le ton sélectionné) — c'est ce qui identifie
  // l'outil à l'écran. Le rognage tombe en bas, sur les boutons, sans intérêt.
  const scale = video.width / SHOT_W;
  const topOffset = 0;

  const coverTop = shot.inkTop - INK_OFFSET - 8;
  const coverHeight = LINE_HEIGHT * FONT_SIZE * 3 + 16;

  // La bulle ne tient QUE 3 lignes : au-delà, le texte débordait sur le renard
  // (constaté en test avec une disquette de 154 caractères). Le prompt demande
  // du court, mais si une longue passe quand même on réduit la police pour
  // rester dans la bulle plutôt que de casser l'image. Plancher à 72 % : en
  // dessous ça ne ressemblerait plus à l'app.
  const textWidth = BUBBLE.right - TEXT_LEFT - 53;
  const AVG_CHAR = 0.52; // largeur moyenne d'un caractère, en em (mesurée sur ces screens)
  const maxChars = (3 * textWidth) / (AVG_CHAR * FONT_SIZE);
  const fitRatio = beat.text.length > maxChars ? maxChars / beat.text.length : 1;
  const fontSize = FONT_SIZE * Math.max(0.72, fitRatio);

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <div
        style={{
          position: "absolute",
          top: topOffset,
          left: 0,
          width: SHOT_W,
          height: shot.h,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <Img src={staticFile(shot.file)} style={{ width: SHOT_W, height: shot.h, display: "block" }} />
        {/* aplat qui masque le placeholder "testttt" — strictement dans la bulle */}
        <div
          style={{
            position: "absolute",
            left: BUBBLE.left + 14,
            top: coverTop,
            width: BUBBLE.right - BUBBLE.left - 28,
            height: coverHeight,
            background: app.bubbleBg,
          }}
        />
        {/* la vraie réponse, calée sur l'encre du placeholder */}
        <div
          style={{
            position: "absolute",
            left: TEXT_LEFT,
            top: shot.inkTop - INK_OFFSET,
            width: textWidth,
            fontFamily: fonts.body,
            fontSize,
            fontWeight: 500,
            lineHeight: LINE_HEIGHT,
            letterSpacing: -0.3,
            color: app.replyText,
          }}
        >
          {renderMaskedText(beat.text)}
        </div>
      </div>
    </AbsoluteFill>
  );
};

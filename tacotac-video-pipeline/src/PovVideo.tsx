import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { fonts } from "./theme";
import type { PovScript } from "./schema";

// ══════════════════════════════════════════════════════════════════════════
//  Format "POV" — 2e type de vidéo (aucune conversation).
//  Un meme réaction par seconde, fondu AU NOIR entre chaque (pas un crossfade :
//  l'image s'ouvre depuis le noir et s'y referme, comme dans les vidéos de réf),
//  sous un texte "pov: ..." fixe et 3 hashtags.
//  On n'utilise pas <TransitionSeries> ici justement parce qu'il ferait un
//  fondu enchaîné entre deux memes ; on veut un vrai passage par le noir.
// ══════════════════════════════════════════════════════════════════════════

export const MEME_FRAMES = 30; // 1s par meme @30fps
const FADE_FRAMES = 6; // 0.2s d'ouverture et autant de fermeture

const videoExts = [".mp4", ".mov", ".webm"];
const isVideo = (p: string) => videoExts.some((e) => p.toLowerCase().endsWith(e));

export const povDuration = (script: PovScript): number =>
  Math.max(1, script.memes.length) * MEME_FRAMES;

// Un meme + son fondu entrant/sortant. L'opacité est pilotée frame par frame
// (fond noir derrière) : c'est ce qui donne le "clignotement noir" propre entre
// deux memes sans jamais superposer deux images.
const MemeSlide: React.FC<{ asset: string }> = ({ asset }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, FADE_FRAMES, MEME_FRAMES - FADE_FRAMES, MEME_FRAMES],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const fill: React.CSSProperties = { width: "100%", height: "100%", objectFit: "contain" };
  return (
    <AbsoluteFill style={{ background: "#000", justifyContent: "center", alignItems: "center", opacity }}>
      {isVideo(asset) ? (
        <OffthreadVideo src={staticFile(asset)} muted style={fill} />
      ) : (
        <Img src={staticFile(asset)} style={fill} />
      )}
    </AbsoluteFill>
  );
};

// Contour noir épais façon CapCut : le texte doit rester lisible sur n'importe
// quel meme (fond clair comme sombre) sans voile assombrissant l'image.
const outlined = (px: number): React.CSSProperties => ({
  WebkitTextStroke: `${px}px #000`,
  paintOrder: "stroke fill",
  textShadow: "0 3px 14px rgba(0,0,0,.55)",
});

// Le texte pov est écrit par le modèle : sa longueur varie d'une vidéo à l'autre.
// On adapte la taille pour rester sur ~3 lignes courtes (le rendu des vidéos de
// référence) sans jamais déborder sur les hashtags.
// Gros caractères, quitte à passer sur 4 lignes (validé) : mieux vaut un texte
// bien lisible en 4 lignes qu'un texte rapetissé pour tenir en 3.
const povFontSize = (text: string): number => {
  const n = text.length;
  if (n <= 85) return 78;
  if (n <= 115) return 70;
  if (n <= 150) return 62;
  if (n <= 200) return 54;
  return 48;
};

// Les hashtags ne sont pas alignés proprement en haut/bas : dans les vidéos de
// référence ils sont posés un peu partout, décalés à gauche ou à droite. On
// définit des dispositions fixes et on en choisit une par vidéo (dérivée de l'id,
// donc stable au rendu mais différente d'une vidéo à l'autre).
// Contrainte : rien entre 40% et 60% de hauteur, c'est la bande du texte pov.
type Slot = React.CSSProperties;
const HASHTAG_LAYOUTS: Slot[][] = [
  [
    { top: "9%", left: "5%", textAlign: "left" },
    { top: "29%", right: "6%", textAlign: "right" },
    { bottom: "14%", left: "10%", textAlign: "left" },
  ],
  [
    { top: "12%", right: "5%", textAlign: "right" },
    { bottom: "30%", left: "6%", textAlign: "left" },
    { bottom: "11%", right: "12%", textAlign: "right" },
  ],
  [
    { top: "8%", left: "9%", textAlign: "left" },
    { bottom: "33%", right: "7%", textAlign: "right" },
    { bottom: "13%", left: "6%", textAlign: "left" },
  ],
  [
    { top: "14%", left: "6%", textAlign: "left" },
    { top: "32%", left: "12%", textAlign: "left" },
    { bottom: "12%", right: "8%", textAlign: "right" },
  ],
];
const layoutFor = (id: string): Slot[] => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HASHTAG_LAYOUTS[h % HASHTAG_LAYOUTS.length];
};

const HASHTAG_RED = "#FF2E4C";

export const PovVideo: React.FC<{ script: PovScript }> = ({ script }) => {
  const { durationInFrames, fps } = useVideoConfig();
  const frame = useCurrentFrame();

  // Fondu de sortie sur la dernière seconde (même règle que MasterVideo) pour ne
  // jamais couper la musique net.
  const fadeFrames = Math.round(fps);
  const volume = interpolate(
    frame,
    [durationInFrames - fadeFrames, durationInFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const slots = layoutFor(script.id);

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Audio src={staticFile("music/pov-music.m4a")} loop volume={volume} />

      {script.memes.map((asset, i) => (
        <Sequence key={i} from={i * MEME_FRAMES} durationInFrames={MEME_FRAMES}>
          <MemeSlide asset={asset} />
        </Sequence>
      ))}

      {/* Calque texte — fixe sur toute la vidéo, jamais affecté par les fondus.
          Le texte pov est posé au-dessus du milieu (et non centré) : il reste
          lisible sans écraser le visage du meme. Les hashtags sont dispersés
          autour, jamais alignés proprement — comme dans les vidéos de référence. */}
      <AbsoluteFill style={{ fontFamily: fonts.body }}>
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "8%",
            right: "8%",
            transform: "translateY(-50%)",
            textAlign: "center",
            color: "#fff",
            fontSize: povFontSize(script.povText),
            fontWeight: 800,
            lineHeight: 1.18,
            letterSpacing: -0.5,
            ...outlined(9),
          }}
        >
          {script.povText}
        </div>

        {script.hashtags.map((h, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              fontSize: 48,
              fontWeight: 800,
              color: HASHTAG_RED,
              ...outlined(6),
              ...slots[i],
            }}
          >
            #{h}
          </div>
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { fonts } from "../theme";

// Intro "marque de fabrique" — extraite des 3 vidéos de référence de Tom
// (animation silhouette qui dunk sur terrain gris, jusqu'à la dernière frame
// avant que l'écran vire au noir). Fichier : public/intro/intro_vierge_basket_spiderman.mov
// (voir reference/exemple-viral-*.mov pour les sources d'origine + pipeline/README.md
// pour la méthode d'extraction si un jour il faut la refaire).
//
// Clip "vierge" (sans sous-titre brûlé) — la légende est maintenant un vrai calque
// Remotion (texte HTML), piochée en rotation par génération (voir INTRO_CAPTIONS
// dans generate.ts) au lieu d'être fixe et identique à chaque vidéo.
//
// Durée mesurée exactement à l'extraction (ffprobe) : NE PAS changer sans re-vérifier
// la vraie durée du fichier (un décalage ferait sauter la fin du fade ou couper trop tôt).
// Durée du clip et calcul de la coupe : voir src/timing.ts (INTRO_DURATION_FRAMES /
// introDurationFrames) — c'est là que vit toute la logique de durée, pour que la
// génération puisse la réutiliser sans importer React.

// Muet : la musique de cette même vidéo tourne en fond sur TOUTE la durée du montage
// (voir <BackgroundMusic> dans MasterVideo.tsx), pas seulement pendant l'intro — sinon
// on aurait le son en double ici + le fond musical en même temps.
export const Intro: React.FC<{ caption?: string; trimFrames?: number; speed?: number }> = ({
  caption,
  trimFrames = 0,
  speed = 1,
}) => (
  <AbsoluteFill style={{ background: "#000" }}>
    <OffthreadVideo
      src={staticFile("intro/intro_vierge_basket_spiderman.mov")}
      muted
      startFrom={trimFrames}
      // Accélération : sert aux musiques dont le drop tombe très tôt (pistolet à
      // 3,5 s). La durée de la scène est calculée en conséquence dans timing.ts.
      playbackRate={speed}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
    {caption && (
      <>
        {/* voile pour la lisibilité du texte, comme <CaptionCard> — assombrit le HAUT
            puisque le texte est maintenant au tiers supérieur, pas en bas */}
        <AbsoluteFill
          style={{ background: "linear-gradient(180deg, rgba(0,0,0,.65), rgba(0,0,0,0) 45%)" }}
        />
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", padding: "38% 60px 0" }}>
          <div
            style={{
              fontFamily: fonts.title,
              fontWeight: 800,
              fontSize: 62,
              lineHeight: 1.12,
              color: "#fff",
              textAlign: "center",
              letterSpacing: -0.8,
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

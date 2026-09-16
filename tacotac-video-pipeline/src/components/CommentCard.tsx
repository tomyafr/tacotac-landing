import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { fonts } from "../theme";

// Écran "commentaire" — format vidéo "réponse aux commentaires" (2e format, voir
// pipeline/generate-comment.ts). Affiche la VRAIE capture d'écran uploadée par le
// collaborateur, telle quelle — jamais un commentaire reconstitué en HTML. Le
// commentaire est TOUJOURS réel (voir la consigne dans generate-comment.ts) :
// Tom/Anomy l'ajoutent à la main dans /partner avec la vraie capture. Affichage
// en "contain" (comme MemeOverlay) : la capture n'est jamais recadrée/déformée.
//
// `caption` : le titre d'accroche (même rôle que introCaption sur l'intro
// Spiderman des vidéos classiques). Ce format n'a PAS d'intro dédiée (Tom, le
// 16/09 : "il n'y a pas d'intro spiderman sur ce format") — le titre s'affiche
// donc directement en haut de CET écran, par-dessus la capture.
export const CommentCard: React.FC<{ image: string; caption?: string }> = ({ image, caption }) => (
  <AbsoluteFill style={{ background: "#000", justifyContent: "center", alignItems: "center" }}>
    <Img src={staticFile(image)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
    {caption && (
      <>
        <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.75), rgba(0,0,0,0) 40%)" }} />
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", padding: "22% 60px 0" }}>
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

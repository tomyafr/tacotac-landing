import React from "react";
import { Img, staticFile } from "remotion";
import { dm, fonts } from "../theme";
import { renderMaskedText } from "./maskedText";

// Bloc d'ouverture "Vous avez répondu à sa story" : label + grande vignette de la
// story (droite) + la réponse du client en bulle violette. Reproduit le vrai DM
// Instagram vu dans refs-videos/ (ouais_bof). Toujours à droite (c'est le client).
export const StoryReply: React.FC<{ thumbnail: string; reply?: string }> = ({
  thumbnail,
  reply,
}) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 14,
        padding: "0 40px",
      }}
    >
      <span
        style={{
          fontFamily: fonts.body,
          fontSize: 26,
          color: "#8E8E93",
          marginRight: 6,
        }}
      >
        Vous avez répondu à sa story
      </span>
      <div
        style={{
          width: 320,
          height: 436,
          borderRadius: 28,
          overflow: "hidden",
          border: `1px solid ${dm.storyThumbBorder}`,
        }}
      >
        <Img
          src={staticFile(thumbnail)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
      {reply && (
        <div
          style={{
            maxWidth: "72%",
            background: dm.bubbleClient,
            color: dm.textPrimary,
            fontFamily: fonts.body,
            fontSize: 36,
            fontWeight: 500,
            lineHeight: 1.3,
            padding: "22px 30px",
            borderRadius: 40,
          }}
        >
          {renderMaskedText(reply)}
        </div>
      )}
    </div>
  );
};

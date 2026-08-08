import React from "react";
import { dm, fonts } from "../theme";
import { Avatar } from "./Avatar";
import { renderMaskedText } from "./maskedText";

// Bulle de message — reproduit le look réel observé dans refs-videos/ :
// fond noir pur, bulles pill (pas de tail), violet (toi) à droite, gris (elle) à gauche.
// L'avatar rond n'apparaît qu'au dernier message d'une série consécutive du même
// expéditeur (règle IG standard) — géré par le parent via `showAvatar`.
export const MessageBubble: React.FC<{
  from: "girl" | "client";
  text: string;
  showAvatar?: boolean;
  girlName?: string;
  girlAvatarSrc?: string;
}> = ({ from, text, showAvatar = false, girlName = "", girlAvatarSrc }) => {
  const isClient = from === "client";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isClient ? "flex-end" : "flex-start",
        alignItems: "flex-end",
        gap: 14,
        padding: "0 40px",
      }}
    >
      {!isClient && (
        <div style={{ width: 76, height: 76, flexShrink: 0 }}>
          {showAvatar && <Avatar name={girlName} src={girlAvatarSrc} size={76} />}
        </div>
      )}
      <div
        style={{
          maxWidth: "72%",
          background: isClient ? dm.bubbleClient : dm.bubbleGirl,
          color: dm.textPrimary,
          fontFamily: fonts.body,
          fontSize: 36,
          fontWeight: 500,
          lineHeight: 1.3,
          padding: "22px 30px",
          borderRadius: 40,
          wordBreak: "break-word",
        }}
      >
        {renderMaskedText(text)}
      </div>
    </div>
  );
};

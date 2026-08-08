import React from "react";
import { Img, staticFile } from "remotion";
import { dm, fonts } from "../theme";

// Avatar rond : photo réelle (staticFile depuis public/girls/) si fournie,
// sinon fallback initiales colorées.

const palette = ["#5B3A29", "#7A4E1E", "#3E2E63", "#1E4E5A", "#5A1E3E", "#2E5A1E"];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const letters = parts.slice(0, 2).map((p) => p[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export const Avatar: React.FC<{ name: string; src?: string; size?: number }> = ({
  name,
  src,
  size = 96,
}) => {
  if (src) {
    return (
      <Img
        src={staticFile(src)}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          objectFit: "cover",
          objectPosition: "50% 22%", // favorise le visage (selfies miroir = visage en haut)
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: colorFor(name),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: dm.textPrimary,
        fontFamily: fonts.body,
        fontWeight: 700,
        fontSize: size * 0.36,
        letterSpacing: 0.5,
        flexShrink: 0,
      }}
    >
      {initialsOf(name)}
    </div>
  );
};

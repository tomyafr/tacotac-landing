import React from "react";

// Sécurité : un pseudo Snap (ou tout identifiant similaire) écrit par le modèle
// pourrait, par hasard, ressembler à un vrai compte existant. On ne l'affiche
// JAMAIS en clair à l'écran — le modèle l'encadre par [[SNAP:...]] (voir le
// prompt dans pipeline/generate.ts) et ce composant remplace ce segment précis
// par une barre de floutage, sans toucher au reste de la phrase.
const SNAP_RE = /\[\[SNAP:([^\]]*)\]\]/g;

export function renderMaskedText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  SNAP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SNAP_RE.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(
      <span key={`snap-${key++}`} style={{ position: "relative", display: "inline-block" }}>
        <span style={{ visibility: "hidden" }}>{match[1]}</span>
        <span
          style={{
            position: "absolute",
            left: -4,
            right: -4,
            top: "30%",
            height: "45%",
            background: "rgba(15,15,15,0.94)",
            borderRadius: 5,
          }}
        />
      </span>
    );
    lastIndex = SNAP_RE.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : text;
}

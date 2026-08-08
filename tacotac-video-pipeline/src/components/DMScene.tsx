import React from "react";
import { useCurrentFrame } from "remotion";
import { DMScreen, type DMItem } from "./DMScreen";
import type { Girl } from "../schema";

// Scène DM continue : affiche `base` (messages déjà révélés dans les scènes DM
// précédentes) dès le départ, puis fait apparaître `reveals` un par un aux frames
// `starts` (pas d'animation de bulle — apparition sèche). Regrouper les messages
// dans une seule scène évite tout fondu entre eux (le fondu est réservé aux
// transitions entre scènes de types différents).
export const DMScene: React.FC<{
  girl: Girl;
  storyReply?: string;
  base: DMItem[];
  reveals: DMItem[];
  starts: number[]; // frame d'apparition de chaque reveal
}> = ({ girl, storyReply, base, reveals, starts }) => {
  const frame = useCurrentFrame();
  const nVisible = starts.filter((s) => frame >= s).length;
  const items = [...base, ...reveals.slice(0, nVisible)];
  return <DMScreen girl={girl} storyReply={storyReply} items={items} />;
};

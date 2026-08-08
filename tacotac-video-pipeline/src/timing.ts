// Découpage temporel d'un script → scènes. Module PUR (aucun import React/Remotion)
// pour que la génération (pipeline/generate.ts) puisse calculer la durée d'une vidéo
// AVANT de la rendre, et rejeter tout ce qui dépasse la limite TikTok.
import type { DMItem } from "./components/DMScreen";
import type { Script, TacotacBeat } from "./schema";
import { resolveMusic } from "./music";
import { video } from "./theme";

// ── Durées par défaut (frames @30fps). Rythme nerveux façon TikTok viral. ──
export const D = {
  outro: 90,
  meme: 42,
  storyOpen: 40, // temps où l'on voit la réponse à la story avant qu'elle réponde
  dmLead: 12, // délai avant le 1er message quand on revient sur le DM (après le fondu)
};
export const FADE = 7; // fondu très léger entre scènes

// Plafond dur : au-delà d'1 min, TikTok coupe/bloque la vidéo pour droits d'auteur
// sur la musique. On vise 59 s pour garder une marge de sécurité.
export const MAX_DURATION_SECONDS = 59;
export const MAX_DURATION_FRAMES = MAX_DURATION_SECONDS * video.fps;

// Intro : clip de 203 frames, coupé du début selon la musique (voir music.ts).
export const INTRO_DURATION_FRAMES = 203; // 6.7667s à 30fps
export const introDurationFrames = (trim = 0) =>
  Math.max(1, INTRO_DURATION_FRAMES - Math.max(0, trim));

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const readTime = (text: string) => clamp(Math.round(28 + text.length * 1.6), 42, 120);
const tacotacTime = (text: string) => clamp(Math.round(58 + text.length * 1.3), 74, 140);
const revealDur = (it: DMItem): number => {
  const factor = it.kind === "msg" && it.from === "client" ? 0.85 : 1;
  return Math.round(readTime(it.text) * factor);
};

export type Scene =
  | { kind: "intro"; dur: number; trim: number }
  | { kind: "caption"; text: string; background: string; variant: "outro"; dur: number }
  | { kind: "dm"; base: DMItem[]; reveals: DMItem[]; starts: number[]; dur: number }
  | { kind: "tacotac"; beat: TacotacBeat; dur: number }
  | { kind: "meme"; asset: string; dur: number };

// Parcourt les beats → scènes. Les messages consécutifs sont regroupés dans UNE
// scène DM continue (aucun fondu entre eux) ; les cutaways (tacotac/meme) coupent
// la scène. Le fondu ne joue qu'entre scènes de types différents.
export function buildScenes(script: Script): Scene[] {
  const scenes: Scene[] = [];
  const revealed: DMItem[] = [];
  let pending: DMItem[] = [];
  let firstDm = true;

  const flushDm = () => {
    if (pending.length === 0) return;
    const base = [...revealed];
    const reveals = [...pending];
    const lead = firstDm && script.storyReply ? D.storyOpen : D.dmLead;
    let t = lead;
    const starts: number[] = [];
    for (const r of reveals) {
      starts.push(t);
      t += revealDur(r);
    }
    scenes.push({ kind: "dm", base, reveals, starts, dur: t });
    revealed.push(...reveals);
    pending = [];
    firstDm = false;
  };

  // Intro "marque de fabrique" fixe (animation + musique de la banque de réf) —
  // ouvre TOUJOURS la vidéo, indépendamment de script.hook (plus utilisé pour le
  // rendu). Le clip est vierge ; la légende (script.introCaption) est un calque
  // Remotion posé par-dessus, voir Intro.tsx. La coupe du début dépend de la
  // musique choisie (chaque drop tombe à un instant différent), voir music.ts.
  const trim = resolveMusic(script.music).introTrim;
  scenes.push({ kind: "intro", dur: introDurationFrames(trim), trim });

  for (const beat of script.beats) {
    if (beat.type === "message") {
      pending.push({ kind: "msg", from: beat.from, text: beat.text });
    } else if (beat.type === "ending") {
      pending.push({ kind: "ending", text: beat.text });
    } else if (beat.type === "tacotac") {
      flushDm();
      scenes.push({ kind: "tacotac", beat, dur: tacotacTime(beat.text) });
    } else if (beat.type === "meme") {
      flushDm();
      scenes.push({ kind: "meme", asset: beat.asset, dur: D.meme });
    }
  }
  flushDm();

  if (script.outro) {
    scenes.push({ kind: "caption", text: script.outro.text, background: script.outro.background, variant: "outro", dur: D.outro });
  }

  return scenes;
}

// Durée totale = somme des scènes moins les recouvrements de fondu.
export const totalDuration = (script: Script): number => {
  const scenes = buildScenes(script);
  const sum = scenes.reduce((s, sc) => s + sc.dur, 0);
  return sum - FADE * Math.max(0, scenes.length - 1);
};

export const durationSeconds = (script: Script): number => totalDuration(script) / video.fps;

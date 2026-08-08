import { z } from "zod";

// Schéma d'un script vidéo. Le render ne réfléchit pas : il rend ce que le JSON dit.

export const girlSchema = z.object({
  name: z.string(),
  avatar: z.string().optional(), // chemin relatif dans public/ (ex: "girls/sophie.png") — absent = fallback initiales
  status: z.string(), // "en ligne il y a 2h", "vue il y a 2 jours", etc.
  storyThumbnail: z.string().optional(), // photo de sa story affichée en haut à droite ("tu as répondu à sa story")
});

export const messageBeat = z.object({
  type: z.literal("message"),
  from: z.enum(["girl", "client"]),
  text: z.string(),
});

// Les 6 modes de l'app (les 3 derniers sont premium)
export const toneEnum = z.enum([
  "classe",
  "drole",
  "spicy",
  "romantique",
  "sexto",
  "mystere",
]);

export const tacotacBeat = z.object({
  type: z.literal("tacotac"),
  tone: toneEnum,
  text: z.string(),
});

export const memeBeat = z.object({
  type: z.literal("meme"),
  asset: z.string(), // chemin dans public/ (ex: "memes/thinking.png")
  beat: z.string(), // tag émotionnel (il_reflechit, victoire, …)
});

export const endingBeat = z.object({
  type: z.literal("ending"),
  kind: z.enum(["date", "snap", "num", "compliment"]),
  text: z.string(),
});

export const beatSchema = z.discriminatedUnion("type", [
  messageBeat,
  tacotacBeat,
  memeBeat,
  endingBeat,
]);

// Hook d'ouverture (texte accrocheur + fond meme/highlight) et CTA de fin
// ("l'IA gratuite est dans ma bio"), tous deux vus sur les 3 vidéos de réf.
export const captionCardSchema = z.object({
  text: z.string(),
  background: z.string(), // chemin dans public/ — image ou clip vidéo
});

export const scriptSchema = z.object({
  id: z.string(),
  girl: girlSchema,
  // Réponse du client à la story de la fille (le message d'ouverture, à droite,
  // sous la vignette "Vous avez répondu à sa story"). Contexte affiché en haut du DM.
  storyReply: z.string().optional(),
  hook: captionCardSchema.optional(),
  // Légende affichée sur l'intro fixe (clip vierge, texte piocké en rotation
  // côté generate.ts — voir INTRO_CAPTIONS). Absent = pas de légende (fallback).
  introCaption: z.string().optional(),
  // Clé de la piste musicale dans MUSIC_TRACKS (src/music.ts) — ex: "pressure",
  // "flex-up", "nba". Chaque piste embarque SA coupe d'intro pour que le panier
  // tombe sur le drop. Absent/inconnu = "bg-music" (piste historique, intro pleine).
  music: z.string().optional(),
  outro: captionCardSchema.optional(),
  beats: z.array(beatSchema),
});

// ── Format "POV" (2e type de vidéo, aucune conversation) ──────────────
// Un meme réaction par seconde sous un texte "pov: ..." fixe + 3 hashtags.
// Généré par pipeline/generate-pov.ts, rendu par la compo PovVideo.
export const povScriptSchema = z.object({
  id: z.string(),
  povText: z.string(),
  hashtags: z.array(z.string()),
  memes: z.array(z.string()), // chemins dans public/ (ex: "memes/olise-chut.mp4")
});

export type Girl = z.infer<typeof girlSchema>;
export type PovScript = z.infer<typeof povScriptSchema>;
export type Beat = z.infer<typeof beatSchema>;
export type MessageBeat = z.infer<typeof messageBeat>;
export type TacotacBeat = z.infer<typeof tacotacBeat>;
export type MemeBeat = z.infer<typeof memeBeat>;
export type EndingBeat = z.infer<typeof endingBeat>;
export type CaptionCardData = z.infer<typeof captionCardSchema>;
export type Tone = z.infer<typeof toneEnum>;
export type Script = z.infer<typeof scriptSchema>;

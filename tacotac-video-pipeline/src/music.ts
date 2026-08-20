// Catalogue des musiques — chaque piste a SON drop à un instant différent, et
// l'intro doit être coupée au début pour que le panier de Spiderman tombe pile
// sur le drop. Fichier et coupe vont donc toujours ensemble : on les déclare ici
// d'un seul bloc pour qu'ils ne puissent jamais se désynchroniser.
//
// `introTrim` = nombre de frames retirées AU DÉBUT de l'intro (30 fps).
// Mesuré en comparant la 1re frame de l'export TikTok validé par Tom aux 203
// frames de l'intro (match de séquence sur 3 s, zone du titre exclue), puis
// recoupé avec la position du drop dans l'audio.
//
// Repères sur l'intro complète (203 frames) : Spiderman atteint le panier vers
// la frame 186-203 (6,2 → 6,77 s). Après coupe de N frames, le panier tombe donc
// à (186-N)/30 s. C'est cette valeur qui doit coïncider avec le drop.
export type MusicTrack = {
  file: string; // chemin dans public/
  introTrim: number; // frames coupées au début de l'intro
  drop: number; // instant du drop dans la piste (secondes) — pour vérification
  // Vitesse de lecture de l'intro. 1 = normal. >1 = accélérée, donc plus courte :
  // c'est le seul moyen de faire tomber le panier sur un drop TRÈS tôt (couper le
  // début ferait disparaître le début de l'action, pas juste la raccourcir).
  introSpeed?: number;
};

export const MUSIC_TRACKS = {
  "bg-music": { file: "music/bg-music.m4a", introTrim: 0, drop: 6.5 },
  pressure: { file: "music/pressure-cale.mp3", introTrim: 0, drop: 6.52 },
  // flex-up : calage d'origine de Tom, validé tel quel.
  "flex-up": { file: "music/flex-up-cale.mp3", introTrim: 24, drop: 5.7 },
  // nba : +8 frames vs l'export d'origine (106) — Tom voulait le drop ~0,25 s après
  // le panier, donc on avance le visuel en coupant un peu plus au début.
  nba: { file: "music/nba-cale.mp3", introTrim: 114, drop: 2.7 },
  // the-box : l'export d'origine ne coupait rien ; 18 frames (0,6 s) en moins.
  "the-box": { file: "music/the-box-cale.mp3", introTrim: 18, drop: 5.9 },
  // pistolet : RÉSERVÉE au profil anomy (voir musicKeysFor() dans generate.ts).
  // Son extrait de la vidéo de référence fournie par Tom. Drop mesuré à 3,50 s
  // (analyse d'enveloppe RMS : quasi-silence jusqu'à 3,45 s puis explosion).
  // C'est BEAUCOUP plus tôt que les autres pistes (5,7-6,5 s), d'où l'accélération
  // plutôt qu'une coupe : 186 frames avant le panier ÷ 1.77 = 105 frames = 3,50 s.
  // L'intro dure alors 203/1.77 ≈ 115 frames au lieu de 203 — c'est exactement
  // l'effet "intro plus courte" de la vidéo de référence.
  pistolet: { file: "music/pistolet_music.m4a", introTrim: 0, drop: 3.5, introSpeed: 1.77 },
} as const satisfies Record<string, MusicTrack>;

export type MusicKey = keyof typeof MUSIC_TRACKS;
export const DEFAULT_MUSIC: MusicKey = "bg-music";

export const resolveMusic = (key?: string): MusicTrack =>
  MUSIC_TRACKS[(key as MusicKey) in MUSIC_TRACKS ? (key as MusicKey) : DEFAULT_MUSIC];

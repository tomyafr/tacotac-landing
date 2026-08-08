/**
 * Générateur de script vidéo Tacotac — full-auto.
 *
 * Écrit la fausse conversation + les disquettes (voix de marque), puis le CODE
 * (pas le modèle) assemble les assets : fille en rotation (jamais de doublon avant
 * d'avoir tourné tout le pool) + memes choisis PAR LE MODÈLE fichier par fichier
 * (pas de pioche aléatoire dans une catégorie). Sortie : un fichier props Remotion
 * { "script": {...} } validé zod.
 *
 * DEUX backends :
 *   - "cli" (défaut) : passe par Claude Code (`claude -p`) → utilise TON ABONNEMENT
 *     (tes %), pas de clé API ni de crédits. C'est le même principe que la 1re vidéo.
 *   - "api" : SDK Anthropic + ANTHROPIC_API_KEY (facturé au token). Flag --api.
 *
 * Usage : npx tsx pipeline/generate.ts [nombre] [--api]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scriptSchema, toneEnum, type Tone } from "../src/schema";
import { durationSeconds, MAX_DURATION_SECONDS } from "../src/timing";
import { MUSIC_TRACKS } from "../src/music";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
// Profil = compte destinataire (ex "solene"). Chaque profil a SA rotation et SA file
// d'attente : deux profils ne tombent jamais sur la même fille / le même angle en même
// temps. Sans TACOTAC_PROFILE, comportement d'origine inchangé (state.json, queue/).
const PROFILE = (process.env.TACOTAC_PROFILE || "").replace(/[^a-z0-9_-]/gi, "");
const SUFFIX = PROFILE ? `-${PROFILE}` : "";
const QUEUE = path.join(HERE, `queue${SUFFIX}`);
const RENDERED = path.join(HERE, `rendered${SUFFIX}`);
const STATE_PATH = path.join(HERE, `state${SUFFIX}.json`);

// ── Ressources ──
const systemPromptTacotac = fs.readFileSync(path.join(REPO, "system_prompt_tacotac.md"), "utf8");
const library = JSON.parse(
  fs.readFileSync(path.join(ROOT, "public", "memes", "library.json"), "utf8")
) as { beats: Record<string, { desc: string; memes: string[] }> };
const beatTags = Object.keys(library.beats);
// Tons autorisés pour les vidéos : classe/spicy/sexto/romantique uniquement — plus de
// drôle (les "blagues" cassaient l'ambiance et convertissaient moins) ni mystère.
// schema.ts garde les 6 tons pour l'app (les composants de rendu les supportent tous),
// seule la GÉNÉRATION est restreinte ici.
const ALLOWED_TONES: readonly Tone[] = ["classe", "spicy", "sexto", "romantique"];
const tones = toneEnum.options.filter((t): t is Tone => ALLOWED_TONES.includes(t));

// Profil "rôles inversés" : une fille (la cliente Tacotac) drague un mec — utilisé pour
// le profil "solene" (compte Amelia). Change juste le dossier d'avatars + le prompt ;
// le schema/rendu ne connaissent que "girl"/"client" (bulle gauche/droite), aucun
// changement nécessaire côté Remotion.
const REVERSED = PROFILE === "solene";
const AVATAR_DIR = REVERSED ? "boys" : "girls";
let girlFiles: string[] = [];
try {
  girlFiles = fs
    .readdirSync(path.join(ROOT, "public", AVATAR_DIR))
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .map((f) => `${AVATAR_DIR}/${f}`);
} catch {
  girlFiles = [];
}
if (girlFiles.length === 0) {
  console.error(`✗ Aucune photo dans public/${AVATAR_DIR}/ — ajoute des fichiers .jpg/.png avant de générer${PROFILE ? ` (profil ${PROFILE})` : ""}.`);
  process.exit(1);
}

// Catalogue plat de tous les memes (basename -> chemin complet + beat d'origine).
// Le modèle choisit le FICHIER exact, pas juste une catégorie — le code ne pioche
// plus au hasard dedans.
const memeCatalog: { basename: string; full: string; beat: string }[] = [];
for (const [beat, { memes }] of Object.entries(library.beats)) {
  for (const full of memes) memeCatalog.push({ basename: full.replace(/^memes\//, ""), full, beat });
}
const memeBasenames = memeCatalog.map((m) => m.basename);
const memeByBasename = new Map(memeCatalog.map((m) => [m.basename, m]));

const OUTRO_BGS = [
  "memes/neymar-rose.jpg",
  "memes/eminem-rose.jpg",
  "memes/curry-panier-lune.jpg",
  "memes/mbappe-sourire-coquin.jpg",
  "memes/shrek-rizz.png",
];

const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
// Emojis : AUCUNE police emoji n'est installée sur le VPS de rendu (vérifié :
// 24 polices, zéro emoji), donc tout emoji sort en carré vide dans la vidéo.
// Le prompt les interdit ; ce filtre garantit qu'aucun ne passe même si le
// modèle désobéit. Couvre aussi les tons de peau, sélecteurs et ZWJ.
const stripEmoji = (s: string) =>
  s.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
const clean = (s: string) => stripEmoji(s.replace(/\s*\.\s*$/u, ""));

// ── Anti-répétition réelle : on montre au modèle ce qui est DÉJÀ sorti ──────
// La rotation d'angles ne suffisait pas : sur 15 vidéos, "mardi" revenait 4 fois,
// la vanne des "prises" 3 fois, et "t'aurais pu prévenir avant de poster ça"
// 2 fois quasi mot pour mot. La cause : les angles décrivent un REGISTRE, et le
// modèle retombe sur la même formulation à l'intérieur de ce registre — en plus
// de recopier les exemples entre parenthèses. On lui met donc sous les yeux ses
// propres sorties passées, avec interdiction d'y retoucher.
function recentOutputs(limit = 25): { stories: string[]; punchlines: string[] } {
  const stories: string[] = [];
  const punchlines: string[] = [];
  try {
    const files = fs
      .readdirSync(RENDERED)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(RENDERED, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, limit);
    for (const { f } of files) {
      try {
        const { script } = JSON.parse(fs.readFileSync(path.join(RENDERED, f), "utf8"));
        if (script?.storyReply) stories.push(script.storyReply);
        for (const b of script?.beats ?? []) {
          if (b?.type === "tacotac" && b.text) punchlines.push(b.text);
        }
      } catch { /* fichier illisible : on l'ignore, l'anti-répétition reste best-effort */ }
    }
  } catch { /* pas encore d'archive (1er run) */ }
  return { stories, punchlines };
}

function buildAvoidBlock(): string {
  const { stories, punchlines } = recentOutputs();
  if (!stories.length && !punchlines.length) return "";
  const list = (arr: string[], max: number) =>
    arr.slice(0, max).map((s) => `- ${s}`).join("\n");
  return `

⛔ DÉJÀ SORTI DANS LES VIDÉOS PRÉCÉDENTES — INTERDIT DE RÉUTILISER
Ne reprends ni ces formulations, ni le RESSORT COMIQUE qu'il y a derrière (même
idée reformulée = même faute). Si ton brouillon ressemble à l'un de ces exemples,
jette-le et trouve un autre angle.

storyReply déjà utilisés :
${list(stories, 25)}

Disquettes déjà utilisées :
${list(punchlines, 25)}`;
}

// ── Angles imposés pour storyReply / hook / outro ──────────────────────────
// Le bug observé (toutes les vidéos ouvrent sur "tu savais que t'étais belle
// en postant ça...") vient du prompt qui ne donnait qu'1 SEUL exemple par
// champ : le modèle le recopiait quasi mot pour mot à chaque génération, vu
// qu'aucune diversité n'était forcée. On applique le même remède que pour la
// rotation des filles (nextGirl) : un angle DIFFÉRENT est imposé à chaque
// vidéo, piochés sans jamais répéter avant d'avoir épuisé tout le pool.
// Contrainte conservée pour storyReply/hook : jamais de détail visuel inventé
// (la vraie photo n'est choisie qu'après, au hasard).
const STORY_REPLY_ANGLES = [
  "reproche taquin : elle savait très bien l'effet que ça allait faire (jamais mot pour mot 'tu savais que t'étais belle', invente ta propre formulation)",
  "vanne sur le nombre de tentatives avant la bonne pose ('la 15e prise ou direct la bonne')",
  "question direct et confiante sur son intention en postant ça, sans compliment explicite",
  "faux reproche joueur : elle aurait dû prévenir avant de poster un truc pareil",
  "hypothèse audacieuse et un peu provocante sur pourquoi elle poste ça maintenant",
  "second degré sur le concept même de poster une story, ironie légère",
  "compliment qui bascule en vanne ou en défi à la fin de la phrase",
  "fausse indifférence jouée, presque blasé, à l'inverse total de s'extasier",
  "constat sec et confiant, presque grognon, zéro compliment direct",
  "comparaison ou image inattendue et un peu absurde, sans inventer de détail visuel réel",
];
// Même registre que STORY_REPLY_ANGLES, pronoms inversés (elle → il) pour le profil
// "rôles inversés" (la cliente répond à SA story à LUI).
const STORY_REPLY_ANGLES_REVERSED = [
  "reproche taquin : il savait très bien l'effet que ça allait faire (jamais mot pour mot 'tu savais que t'étais beau', invente ta propre formulation)",
  "vanne sur le nombre de tentatives avant la bonne pose ('la 15e prise ou direct la bonne')",
  "question directe et confiante sur son intention en postant ça, sans compliment explicite",
  "faux reproche joueur : il aurait dû prévenir avant de poster un truc pareil",
  "hypothèse audacieuse et un peu provocante sur pourquoi il poste ça maintenant",
  "second degré sur le concept même de poster une story, ironie légère",
  "compliment qui bascule en vanne ou en défi à la fin de la phrase",
  "fausse indifférence jouée, presque blasée, à l'inverse total de s'extasier",
  "constat sec et confiant, presque grognon, zéro compliment direct",
  "comparaison ou image inattendue et un peu absurde, sans inventer de détail visuel réel",
];
const OUTRO_ANGLES = [
  "CTA complice, dans le même esprit que 'l'ia gratuite est dans ma bio les coquins' — mais invente ta propre phrase, jamais celle-ci mot pour mot",
  "CTA avec une légère urgence ou rareté, sans mentir sur une promo qui n'existe pas",
  "CTA ton complice 'entre nous', comme un bon plan partagé discrètement",
  "CTA qui défie le viewer d'essayer et de voir le résultat par lui-même",
  "CTA qui garde un peu de mystère sur comment ça marche exactement",
  "CTA très direct et court, sans détour",
];

// Archétype de conversation — dicte la FORME de tout l'échange (pas juste la
// ligne d'ouverture) : quel est le conflit/l'enjeu qui traverse la conv du début
// à la fin. Sans ça, les convs finissent toutes en "banter plat" interchangeable.
const CONVERSATION_ARCHETYPES = [
  "elle teste si c'est un profil fake / si les photos sont vraies, il doit la rassurer avec culot plutôt que se justifier platement",
  "elle est froide et distante au début (réponses courtes, presque désintéressée), et se réchauffe progressivement au fil de la conv",
  "elle négocie fermement la logistique du date (lieu, horaire, qui décide), teste s'il tient bon sans juste céder",
  "elle mentionne un autre mec / une légère compétition, il doit rester confiant sans paraître jaloux ni désespéré",
  "long silence de sa part puis elle relance elle-même, ou l'inverse — le client relance après un silence sans être lourd",
  "elle le vanne sur un détail (son look, sa réplique, son âge...) et le banter monte crescendo en complicité",
  "elle pose une question piège / directe sur ses intentions (sérieux vs juste physique), il doit répondre avec assurance sans fuir",
  "elle change de sujet ou évite une question, le client doit rebondir sans s'accrocher ni paraître vexé",
];
// Même registre que CONVERSATION_ARCHETYPES, rôles inversés : lui teste/négocie/hésite,
// la cliente (Amelia) mène la conv et l'assure — jamais elle qui doute d'elle-même.
const CONVERSATION_ARCHETYPES_REVERSED = [
  "il teste si c'est un profil fake / si les photos sont vraies, elle doit le rassurer avec culot plutôt que se justifier platement",
  "il est froid et distant au début (réponses courtes, presque désintéressé), et se réchauffe progressivement au fil de la conv",
  "il négocie fermement la logistique du date (lieu, horaire, qui décide), teste si elle tient bon sans juste céder",
  "il mentionne une autre fille / une légère compétition, elle doit rester confiante sans paraître jalouse ni désespérée",
  "long silence de sa part puis il relance lui-même, ou l'inverse — la cliente relance après un silence sans être lourde",
  "il la vanne sur un détail (son look, sa réplique, son âge...) et le banter monte crescendo en complicité",
  "il pose une question piège / directe sur ses intentions (sérieux vs juste physique), elle doit répondre avec assurance sans fuir",
  "il change de sujet ou évite une question, la cliente doit rebondir sans s'accrocher ni paraître vexée",
];

// Musiques disponibles (voir src/music.ts) — chacune embarque SA coupe d'intro pour
// que le panier tombe sur le drop. Tirées en rotation comme le reste : sans ça, le
// champ script.music restait vide et le rendu retombait toujours sur bg-music.
const MUSIC_KEYS = Object.keys(MUSIC_TRACKS);

// Légende incrustée sur l'intro (le clip lui-même est maintenant "vierge", sans texte
// brûlé — voir Intro.tsx). Volontairement peu varié (demande explicite) : un petit pool
// de 4 formulations, en rotation anti-répétition comme le reste, PARTAGÉ entre tous les
// profils (pas de version spécifique par profil, contrairement aux archétypes).
const INTRO_CAPTIONS = [
  "regarde comment j'ai géré ce pain",
  "tuto : gérer son pain",
  "tuto dm son crush",
  "tuto rattraper une conv qui part mal",
];

// Pools actifs pour ce profil (droits pour "solene"/Amelia, par défaut sinon).
const ACTIVE_STORY_ANGLES = REVERSED ? STORY_REPLY_ANGLES_REVERSED : STORY_REPLY_ANGLES;
const ACTIVE_ARCHETYPES = REVERSED ? CONVERSATION_ARCHETYPES_REVERSED : CONVERSATION_ARCHETYPES;

// ── Rotation générique : jamais de doublon avant d'avoir épuisé tout le pool ──
// (corrige le bug "2 fois la même fille" observé sur un batch de 5 vidéos —
// même mécanique réutilisée pour les angles d'écriture ci-dessus).
type State = {
  girlOrder: string[]; girlIndex: number;
  storyAngleOrder: string[]; storyAngleIndex: number;
  outroAngleOrder: string[]; outroAngleIndex: number;
  archetypeOrder: string[]; archetypeIndex: number;
  captionOrder: string[]; captionIndex: number;
  musicOrder: string[]; musicIndex: number;
};
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function loadState(): State {
  const fresh = (): State => ({
    girlOrder: shuffle(girlFiles), girlIndex: 0,
    storyAngleOrder: shuffle(ACTIVE_STORY_ANGLES), storyAngleIndex: 0,
    outroAngleOrder: shuffle(OUTRO_ANGLES), outroAngleIndex: 0,
    archetypeOrder: shuffle(ACTIVE_ARCHETYPES), archetypeIndex: 0,
    captionOrder: shuffle(INTRO_CAPTIONS), captionIndex: 0,
    musicOrder: shuffle(MUSIC_KEYS), musicIndex: 0,
  });
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
    const ok =
      Array.isArray(s.girlOrder) && s.girlOrder.length === girlFiles.length &&
      Array.isArray(s.storyAngleOrder) && s.storyAngleOrder.length === ACTIVE_STORY_ANGLES.length &&
      Array.isArray(s.outroAngleOrder) && s.outroAngleOrder.length === OUTRO_ANGLES.length &&
      Array.isArray(s.archetypeOrder) && s.archetypeOrder.length === ACTIVE_ARCHETYPES.length &&
      Array.isArray(s.captionOrder) && s.captionOrder.length === INTRO_CAPTIONS.length &&
      Array.isArray(s.musicOrder) && s.musicOrder.length === MUSIC_KEYS.length;
    return ok ? s : fresh();
  } catch {
    return fresh(); // pas de state ou invalide → on en crée un
  }
}
function saveState(state: State) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function nextGirl(state: State): string {
  if (state.girlIndex >= state.girlOrder.length) {
    state.girlOrder = shuffle(girlFiles);
    state.girlIndex = 0;
  }
  const girl = state.girlOrder[state.girlIndex];
  state.girlIndex++;
  saveState(state);
  return girl;
}
function nextMusic(state: State): string {
  if (state.musicIndex >= state.musicOrder.length) {
    state.musicOrder = shuffle(MUSIC_KEYS);
    state.musicIndex = 0;
  }
  const music = state.musicOrder[state.musicIndex];
  state.musicIndex++;
  saveState(state);
  return music;
}
function nextIntroCaption(state: State): string {
  if (state.captionIndex >= state.captionOrder.length) {
    state.captionOrder = shuffle(INTRO_CAPTIONS);
    state.captionIndex = 0;
  }
  const caption = state.captionOrder[state.captionIndex];
  state.captionIndex++;
  saveState(state);
  return caption;
}
function nextAngle(pool: string[], order: string[], index: number): { angle: string; order: string[]; index: number } {
  if (index >= order.length) { order = shuffle(pool); index = 0; }
  const angle = order[index];
  return { angle, order, index: index + 1 };
}
function nextAngles(state: State): { story: string; outro: string; archetype: string } {
  const s = nextAngle(ACTIVE_STORY_ANGLES, state.storyAngleOrder, state.storyAngleIndex);
  state.storyAngleOrder = s.order; state.storyAngleIndex = s.index;
  const o = nextAngle(OUTRO_ANGLES, state.outroAngleOrder, state.outroAngleIndex);
  state.outroAngleOrder = o.order; state.outroAngleIndex = o.index;
  const a = nextAngle(ACTIVE_ARCHETYPES, state.archetypeOrder, state.archetypeIndex);
  state.archetypeOrder = a.order; state.archetypeIndex = a.index;
  saveState(state);
  return { story: s.angle, outro: o.angle, archetype: a.angle };
}

// ── Prompt de génération (partagé par les 2 backends) ──
// Fonction (pas une constante figée) : storyReply/outroText reçoivent un ANGLE
// DIFFÉRENT à chaque appel (voir nextAngles) pour empêcher le modèle de retomber
// sur la même formulation à chaque génération.
// NB : pas de hookTitle — chaque vidéo ouvre sur l'intro fixe (voir Intro.tsx),
// le sous-titre "apprends de mon football..." est incrusté dans ce clip.
function buildGenInstruction(angles: { story: string; outro: string; archetype: string }): string {
  const format = REVERSED
    ? `FORMAT : une fille (la cliente, bulles à droite) drague un mec (bulles à gauche) en DM Instagram/Snap — PAS une app de rencontre à "match", ils se suivent déjà ou se connaissent un peu. Elle répond à sa story, la conv s'enchaîne, à un moment elle ouvre Tacotac qui lui donne une réplique qui claque, elle l'envoie, ça marche, la conv finit sur une bonne note (il valide / donne son snap / accepte un date). Des memes réactions ponctuent la conv.`
    : `FORMAT : un mec (le client, bulles à droite) drague une fille (bulles à gauche) en DM Instagram/Snap — PAS une app de rencontre à "match", ils se suivent déjà ou se connaissent un peu. Il répond à sa story, la conv s'enchaîne, à un moment il ouvre Tacotac qui lui donne une réplique qui claque, il l'envoie, ça marche, la conv finit sur une bonne note (elle valide / donne son snap / accepte un date). Des memes réactions ponctuent la conv.`;
  const qualityRules = REVERSED
    ? `RÈGLES DE QUALITÉ DES MESSAGES (le point faible n°1 des vidéos ratées — lis bien) :
- Donne au mec un TRAIT DE CARACTÈRE dominant pour CETTE conv (taquin / sceptique / pressé / joueur / direct-cash / distant...) et TIENS-le sur tout l'échange — jamais un mec "gentil" générique et interchangeable.
- Chaque message du mec RÉAGIT PRÉCISÉMENT à ce que la cliente vient de dire — jamais une réplique qui marcherait tout aussi bien dans n'importe quelle autre conv.
- INTERDIT les messages creux ("mdrr" ou "ok" tout seul, sans contenu) — chaque message fait avancer la conv ou la tension. Un mot seul est permis UNE fois max, jamais en double.
- Vraie PROGRESSION : la tension/complicité doit monter au fil des beats (pas un plateau plat de banter interchangeable) et se résoudre logiquement sur la fin positive — le lecteur doit sentir un ARC, pas une suite de vannes random.
- Les messages de la CLIENTE (hors moments tacotac) doivent aussi avoir du répondant — jamais fade, jamais juste des questions plates. Elle mène la conv avec assurance, jamais dans le doute.`
    : `RÈGLES DE QUALITÉ DES MESSAGES (le point faible n°1 des vidéos ratées — lis bien) :
- Donne à la fille un TRAIT DE CARACTÈRE dominant pour CETTE conv (taquine / sceptique / pressée / joueuse / direct-cash / distante...) et TIENS-le sur tout l'échange — jamais une fille "gentille" générique et interchangeable.
- Chaque message de la fille RÉAGIT PRÉCISÉMENT à ce que le client vient de dire — jamais une réplique qui marcherait tout aussi bien dans n'importe quelle autre conv.
- INTERDIT les messages creux ("mdrr" ou "ok" tout seul, sans contenu) — chaque message fait avancer la conv ou la tension. Un mot seul est permis UNE fois max, jamais en double.
- Vraie PROGRESSION : la tension/complicité doit monter au fil des beats (pas un plateau plat de banter interchangeable) et se résoudre logiquement sur la fin positive — le lecteur doit sentir un ARC, pas une suite de vannes random.
- Les messages du CLIENT (hors moments tacotac) doivent aussi avoir du répondant — jamais fade, jamais juste des questions plates.`;
  const structureRules = REVERSED
    ? `RÈGLES DE STRUCTURE :
- storyReply : le TOUT PREMIER message de la cliente, en réponse à la story du mec.
- beats : 8 à 11 éléments qui alternent (COURT — une vidéo qui dure moins de 45 s tourne mieux qu'une longue histoire à suivre). Types :
  • {"kind":"message","from":"girl"|"client","text":"..."} — ici "girl" = le mec dragué (bulle gauche), "client" = la cliente Tacotac (bulle droite).
  • {"kind":"tacotac","tone":"<ton>","text":"..."} — la cliente ouvre l'app. DOIT être suivi IMMÉDIATEMENT d'un {"kind":"message","from":"client","text":"..."} avec EXACTEMENT le même texte. Utilise 1 à 2 moments tacotac, au ton le plus adapté.
  • {"kind":"meme","asset":"<nom-de-fichier-exact>"} — 2 à 3 memes à des moments comiques. Choisis le fichier qui correspond LE MIEUX à ce qui vient d'être dit (voir catalogue ci-dessous), pas juste une catégorie vague.
- Fin : dernier message du mec clairement positif, qui résout l'archétype imposé ci-dessus.
- girlName : prénom crédible pour LE MEC dragué (le champ s'appelle "girlName" mais tient ici le prénom du mec). status : ex "en ligne il y a 2h".`
    : `RÈGLES DE STRUCTURE :
- storyReply : le TOUT PREMIER message du client, en réponse à la story de la fille.
- beats : 8 à 11 éléments qui alternent (COURT — une vidéo qui dure moins de 45 s tourne mieux qu'une longue histoire à suivre). Types :
  • {"kind":"message","from":"girl"|"client","text":"..."}
  • {"kind":"tacotac","tone":"<ton>","text":"..."} — le client ouvre l'app. DOIT être suivi IMMÉDIATEMENT d'un {"kind":"message","from":"client","text":"..."} avec EXACTEMENT le même texte. Utilise 1 à 2 moments tacotac, au ton le plus adapté.
  • {"kind":"meme","asset":"<nom-de-fichier-exact>"} — 2 à 3 memes à des moments comiques. Choisis le fichier qui correspond LE MIEUX à ce qui vient d'être dit (voir catalogue ci-dessous), pas juste une catégorie vague.
- Fin : dernier message de la fille clairement positif, qui résout l'archétype imposé ci-dessus.
- girlName : prénom crédible. status : ex "en ligne il y a 2h".`;
  return `Tu génères le SCÉNARIO d'une vidéo TikTok "fausse conversation de dating" qui fait la promo de Tacotac (l'app qui souffle les disquettes).

${format}
⛔ INTERDIT : les mots "match"/"matché"/"on a matché" ou toute référence à une app de rencontre (Tinder, Hinge, Bumble...) — l'outil est pour du DM Insta/Snap, pas du swipe.

⚠️ ARCHÉTYPE IMPOSÉ POUR CETTE VIDÉO — c'est le FIL CONDUCTEUR de toute la conv, pas juste la 1ère ligne. Construis les beats "message" autour de CET enjeu précis, du début à la résolution en fin de conv :
${angles.archetype}

${qualityRules}

⚠️ LA DISQUETTE — c'est LE truc qu'on vend, tout le reste n'est que décor :
- Une disquette n'est PAS une phrase d'accroche ni une observation. C'est une réplique qui MET LA PRESSION : elle donne à la fille un truc auquel elle est OBLIGÉE de réagir. Si elle peut répondre "ah ok mdr" et que la conv est morte, c'est raté.
- Elle doit contenir un RETOURNEMENT : tu commences dans une direction, tu finis ailleurs. Une phrase plate qui dit juste un compliment ou un constat n'est pas une disquette.
- Elle doit être VOLABLE : le viewer doit pouvoir la ressortir telle quelle dans sa propre conv, sans rien changer. Donc zéro détail qui ne marche que dans CETTE conv précise.
- INTERDIT : les questions molles ("t'as passé une bonne journée ?"), les compliments secs ("t'es trop belle"), les constats sans enjeu ("tu postes souvent des stories").

⚠️ LE STORY REPLY — même exigence, c'est la 1re seconde de la vidéo :
- ⛔ Le piège dans lequel toutes les vidéos précédentes sont tombées : commenter LE FAIT DE POSTER une story (combien de prises, quel jour, quelle heure, "t'aurais pu prévenir", "c'est quoi le but"). C'est devenu un tic, n'y touche plus.
- Vise plutôt : lui prêter une intention précise et assumée, la mettre au défi, la vanner sur un truc qu'elle n'a pas vu venir, ou ouvrir sur une affirmation gonflée qu'elle devra contredire.
- Il doit APPELER une réponse : après l'avoir lu, elle a envie de répliquer, pas juste de liker.

⚠️ FORMAT COURT ET LISIBLE (priorité n°1 — c'est ce qui fait la différence entre une vidéo qui tourne et une qui meurt) :
- La vidéo entière doit tenir SOUS 59 SECONDES, intro comprise. Vise une conv courte et dense, pas une histoire à rallonge.
- La disquette Tacotac doit se comprendre INSTANTANÉMENT, sans avoir suivi toute la conv : le viewer tombe dessus au milieu du scroll. Une vanne qui a besoin de 4 messages de contexte pour être drôle est une vanne ratée ici.
- Pas de scénario alambiqué : un enjeu simple, lisible en 2 secondes, résolu par la disquette. Le viewer doit pouvoir screenshot la disquette et la réutiliser telle quelle.
- Messages COURTS (une ligne, comme un vrai DM). Aucun pavé.

${structureRules}

⚠️ ANGLES IMPOSÉS POUR CETTE VIDÉO — n'en dévie pas, et n'utilise JAMAIS mot pour mot la formulation d'un exemple donné entre parenthèses (ce sont des illustrations du REGISTRE, pas des phrases à recopier) :
- storyReply : ${angles.story}
- outroText : ${angles.outro}

⚠️ CONTRAINTE CRITIQUE — STORY REPLY : tu ne vois PAS la photo réelle qui sera utilisée (elle est choisie séparément, au hasard, parmi des selfies miroir). N'INVENTE JAMAIS un détail visuel précis dans storyReply : pas d'objet (verre, lunettes, téléphone...), pas de lieu (café, plage, restau...), pas d'activité (${REVERSED ? "il boit, il mange" : "elle boit, elle mange"}...), pas d'animal, pas de vêtement précis. Toute affirmation sur le contenu de la photo a de grandes chances d'être fausse et de casser l'immersion. Reste sur des remarques qui marchent avec N'IMPORTE QUEL selfie miroir en tenue.

VOIX (tout le texte) : minuscules, JAMAIS de point final, phonétique naturelle (jsuis, jte, jsp, tkt, mdr), court et ancré, jamais daté ni "coach drague YouTube". Les disquettes suivent STRICTEMENT le system prompt Tacotac ci-dessus.

⛔ ZÉRO EMOJI, nulle part (ni dans les messages, ni dans storyReply, ni dans outroText). La vidéo est rendue sur un serveur sans police emoji : chaque emoji sort en carré vide à l'écran. Le rire passe par les mots, pas par un 😭.

⚠️ SÉCURITÉ — PSEUDO SNAP : la conv peut se terminer sur un échange de snap ("envoie ton snap", "tiens : xxx"), c'est autorisé. Mais si tu écris un pseudo (snap, insta, numéro...), il ne doit JAMAIS ressembler à un vrai compte existant — invente toujours quelque chose de clairement fictif. ET tu DOIS encadrer EXACTEMENT le pseudo (rien d'autre autour) avec [[SNAP:...]], par exemple : "tiens [[SNAP:jul.xk22]] ajoute moi" — jamais le reste de la phrase dans les crochets, uniquement le pseudo lui-même.

CATALOGUE DE MEMES (choisis le fichier exact le plus pertinent, groupés par ambiance) — les fichiers marqués [GIF] sont animés (plus vivants qu'une image fixe) : PRÉFÈRE un [GIF] à une image fixe quand les deux sont pertinents pour le beat, vise au moins 1 [GIF] dans la vidéo si le catalogue en propose un qui colle :
${beatTags.map((t) => `- ${t} (${library.beats[t].desc}) : ${library.beats[t].memes.map((m) => { const base = m.replace(/^memes\//, ""); return base.toLowerCase().endsWith(".mp4") ? `${base} [GIF]` : base; }).join(", ")}`).join("\n")}

TONS TACOTAC AUTORISÉS : ${tones.join(", ")}
${buildAvoidBlock()}

Chaque vidéo doit raconter une conv DIFFÉRENTE, avec un vocabulaire et des images différentes des vidéos précédentes.`;
}

const jsonShape = `Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour ni bloc de code, de cette forme exacte :
{"girlName":"...","status":"...","storyReply":"...","outroText":"...","beats":[{"kind":"message","from":"girl","text":"..."}, {"kind":"tacotac","tone":"spicy","text":"..."}, {"kind":"meme","asset":"carton-rouge.jpg"}]}`;

// JSON schema (backend API uniquement — sortie structurée garantie)
const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    girlName: { type: "string" },
    status: { type: "string" },
    storyReply: { type: "string" },
    outroText: { type: "string" },
    beats: {
      type: "array",
      items: {
        anyOf: [
          { type: "object", additionalProperties: false, required: ["kind", "from", "text"], properties: { kind: { const: "message" }, from: { enum: ["girl", "client"] }, text: { type: "string" } } },
          { type: "object", additionalProperties: false, required: ["kind", "tone", "text"], properties: { kind: { const: "tacotac" }, tone: { enum: tones }, text: { type: "string" } } },
          { type: "object", additionalProperties: false, required: ["kind", "asset"], properties: { kind: { const: "meme" }, asset: { enum: memeBasenames } } },
        ],
      },
    },
  },
  required: ["girlName", "status", "storyReply", "outroText", "beats"],
} as const;

type GenBeat =
  | { kind: "message"; from: "girl" | "client"; text: string }
  | { kind: "tacotac"; tone: string; text: string }
  | { kind: "meme"; asset: string };
type GenOutput = {
  girlName: string;
  status: string;
  storyReply: string;
  outroText: string;
  beats: GenBeat[];
};

// ── Backend CLI : Claude Code (abonnement) ──
function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Pas de JSON dans la sortie");
  return raw.slice(start, end + 1);
}

// Résout le binaire claude. Sous cron le PATH est minimal, donc on accepte
// CLAUDE_BIN et on teste les emplacements d'installation npm classiques.
function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === "win32") return "claude.cmd";
  const home = process.env.HOME ?? "/root";
  const candidates = [
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    `${home}/.npm-global/bin/claude`,
    `${home}/.local/bin/claude`,
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* candidat absent, on continue */
    }
  }
  return "claude"; // dernier recours : le PATH
}

function callCli(angles: { story: string; outro: string; archetype: string }): GenOutput {
  const prompt = `${systemPromptTacotac}\n\n═══════════\n${buildGenInstruction(angles)}\n\n${jsonShape}\n\nGénère un nouveau scénario, original et drôle.`;
  const isWin = process.platform === "win32";
  const bin = resolveClaudeBin();
  const stdout = execFileSync(bin, ["-p", "--output-format", "json"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: isWin, // Node refuse .cmd sans shell sur Windows
  });
  let resultText = stdout;
  try {
    const env = JSON.parse(stdout);
    if (env.is_error) {
      throw new Error(`Claude Code: ${env.result} (fais 'claude login')`);
    }
    resultText = env.result ?? stdout;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Claude Code:")) throw e;
  }
  return JSON.parse(extractJson(resultText)) as GenOutput;
}

// ── Backend API : SDK Anthropic (clé + crédits) ──
async function callApi(angles: { story: string; outro: string; archetype: string }): Promise<GenOutput> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const params: Record<string, unknown> = {
    model: "claude-opus-4-8",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: `${systemPromptTacotac}\n\n═══════════\n${buildGenInstruction(angles)}`,
    output_config: { format: { type: "json_schema", schema: outputSchema } },
    messages: [{ role: "user", content: "Génère un nouveau scénario de vidéo, original et drôle." }],
  };
  const res = await client.messages.create(params as never);
  const block = res.content.find((b: { type: string }) => b.type === "text") as { text: string } | undefined;
  if (!block) throw new Error("Pas de sortie texte du modèle");
  return JSON.parse(block.text) as GenOutput;
}

// Résout un asset choisi par le modèle ; si absent/halluciné, retombe sur un
// meme au hasard dans TOUT le catalogue (mieux qu'un plantage, reste discret).
function resolveMemeAsset(asset: string): { full: string; beat: string } {
  const hit = memeByBasename.get(asset) ?? memeByBasename.get(path.basename(asset));
  if (hit) return { full: hit.full, beat: hit.beat };
  console.warn(`⚠️ meme inconnu "${asset}" — fallback aléatoire`);
  return rand(memeCatalog);
}

function assemble(g: GenOutput, state: State) {
  const girl = nextGirl(state);
  const introCaption = nextIntroCaption(state);
  const music = nextMusic(state);
  const beats = g.beats.map((b) => {
    if (b.kind === "message") return { type: "message", from: b.from, text: clean(b.text) };
    if (b.kind === "tacotac") return { type: "tacotac", tone: b.tone, text: clean(b.text) };
    const { full, beat } = resolveMemeAsset(b.asset);
    return { type: "meme", asset: full, beat };
  });
  return {
    id: `vid_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    girl: { name: g.girlName, avatar: girl, status: g.status, storyThumbnail: girl },
    storyReply: clean(g.storyReply),
    // Intro fixe (voir Intro.tsx) : le clip est vierge, la légende est piochée ici
    // en rotation anti-répétition (voir INTRO_CAPTIONS), pas générée par le modèle.
    introCaption,
    // Musique en rotation : le rendu en déduit aussi la coupe d'intro (music.ts).
    music,
    outro: { text: clean(g.outroText), background: rand(OUTRO_BGS) },
    beats,
  };
}

// Une vidéo trop longue se fait couper/bloquer par TikTok (droits musique) : on
// régénère jusqu'à tomber sous la limite plutôt que de rendre un scénario perdu
// d'avance. Le modèle reçoit la contrainte dans le prompt, donc c'est rare.
const MAX_LENGTH_RETRIES = 3;

async function generateOne(backend: "cli" | "api", state: State) {
  let script: ReturnType<typeof assemble> | null = null;
  for (let attempt = 1; attempt <= MAX_LENGTH_RETRIES; attempt++) {
    const angles = nextAngles(state); // 1 angle différent par champ, jamais répété avant d'avoir tout épuisé
    const g = backend === "api" ? await callApi(angles) : callCli(angles);
    const candidate = assemble(g, state);
    scriptSchema.parse(candidate); // rejette tout scénario invalide (compat render)
    const secs = durationSeconds(scriptSchema.parse(candidate));
    if (secs <= MAX_DURATION_SECONDS) {
      script = candidate;
      console.log(`   durée ${secs.toFixed(1)}s ✅`);
      break;
    }
    console.warn(`   ⚠️ ${secs.toFixed(1)}s > ${MAX_DURATION_SECONDS}s — régénération (${attempt}/${MAX_LENGTH_RETRIES})`);
  }
  if (!script) throw new Error(`Impossible d'obtenir un scénario sous ${MAX_DURATION_SECONDS}s après ${MAX_LENGTH_RETRIES} essais`);
  const outPath = path.join(QUEUE, `${script.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ script }, null, 2));
  return outPath;
}

// Self-test hors modèle : vérifie assemble + validation zod.
function selfTest() {
  const fake: GenOutput = {
    girlName: "Léa",
    status: "en ligne il y a 1h",
    storyReply: "ok tu savais que t'étais belle en postant ça.",
    outroText: "l'ia gratuite est dans ma bio les coquins.",
    beats: [
      { kind: "message", from: "girl", text: "ouais bof ?? 😭" },
      { kind: "meme", asset: memeBasenames[0] },
      { kind: "tacotac", tone: tones[2], text: "jrigole t'es clairement dans mon top 3" },
      { kind: "message", from: "client", text: "jrigole t'es clairement dans mon top 3" },
      { kind: "message", from: "girl", text: "mdrrr ok t'as gagné des points" },
      { kind: "meme", asset: "fichier-qui-nexiste-pas.jpg" }, // teste le fallback
    ],
  };
  const state = loadState();
  scriptSchema.parse(assemble(fake, state));
  console.log("✅ self-test OK — assemble + validation zod passent (fallback meme inclus)");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selfTest();

  const backend: "cli" | "api" = args.includes("--api") ? "api" : "cli";
  if (backend === "api" && !process.env.ANTHROPIC_API_KEY) {
    console.error("❌ Backend API demandé mais ANTHROPIC_API_KEY manquant.");
    process.exit(1);
  }
  const n = Math.max(1, parseInt(args.find((a) => /^\d+$/.test(a)) ?? "1", 10) || 1);
  fs.mkdirSync(QUEUE, { recursive: true });
  console.log(`Backend: ${backend === "cli" ? "Claude Code (abonnement)" : "API (crédits)"}`);

  const state = loadState();
  for (let i = 0; i < n; i++) {
    try {
      const p = await generateOne(backend, state);
      console.log(`✅ ${i + 1}/${n} → ${path.basename(p)}`);
    } catch (e) {
      console.error(`❌ ${i + 1}/${n} échec :`, (e as Error).message);
    }
  }
}

main();

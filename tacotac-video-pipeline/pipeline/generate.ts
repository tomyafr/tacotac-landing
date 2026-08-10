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
// Ce que veut dire chaque ton POUR LA CHUTE. Sans ça le modèle écrivait la même
// chute romantique quel que soit le ton affiché à l'écran.
const TONE_BRIEFS: Record<string, string> = {
  classe: "élégant et sûr de lui. La chute est un compliment bien tourné, jamais lourd. Image classique (les yeux, le sourire, une œuvre d'art, se perdre).",
  spicy: "taquin et joueur, il la chambre. La chute pique un peu, elle sous-entend sans jamais être vulgaire. Il a de l'aplomb, il se moque gentiment.",
  sexto: "chaud mais SUGGÉRÉ, jamais explicite ni vulgaire. La chute joue sur le trouble, la température, l'envie — par l'allusion (la clim, le souffle, la nuit blanche), jamais par le mot cru.",
  romantique: "sincère et désarmant. La chute est un aveu franc, un peu vulnérable. C'est le ton le plus doux, sans ironie.",
};
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
    // On lit rendered/ ET queue/ : sans la file d'attente, les vidéos d'un même
    // lot ne se voient pas entre elles et convergent (les 3 titres d'un batch
    // commençaient tous par "comment je...").
    const dirs = [RENDERED, QUEUE];
    const files = dirs
      .flatMap((dir) => {
        try {
          return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => ({ full: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }));
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.t - a.t)
      .slice(0, limit);
    for (const { full } of files) {
      try {
        const { script } = JSON.parse(fs.readFileSync(full, "utf8"));
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
  "elle dit qu'elle est occupée / qu'elle a pas le temps, il ne la supplie pas et retourne ça en sa faveur",
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
  "il dit qu'il est occupé / qu'il a pas le temps, elle ne le supplie pas et retourne ça en sa faveur",
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

// Deux formats de vidéo en alternance stricte (une sur deux) :
//  A — il répond à la story lui-même, Tacotac ne souffle QUE la réplique
//  B — Tacotac écrit le 1er DM, puis la réplique (les 2 outils sont montrés)
type Structure = "A" | "B";
const STRUCTURES: Structure[] = ["A", "B"];

// Légende incrustée sur l'intro (le clip est "vierge", sans texte brûlé — voir
// Intro.tsx). Elle était tirée au sort par le code dans un pool figé de 4 phrases :
// résultat, le titre n'avait aucun rapport avec la conv en dessous ("tuto dm son
// crush" sur une vidéo de relance, par exemple). C'est maintenant LE MODÈLE qui
// l'écrit, en cohérence avec le scénario qu'il vient de produire — ces 5 exemples
// ne servent que de registre, il doit s'en inspirer sans les recopier.
// Volontairement SIMPLE et générique : on a essayé de le faire écrire par le
// modèle en cohérence avec la conv, ça donnait des titres trop travaillés et des
// tournures bizarres. Le titre n'a pas à raconter la vidéo, juste à annoncer la
// couleur. Tiré en rotation par le code, comme les filles et les musiques.
// Titres d'intro. Les 4 premiers sont RELEVÉS SUR LES VIDÉOS DE TOM qui ont
// marché (reference/inspiration/) : première personne + souvent un aparté adressé
// aux gars entre parenthèses ou astérisques. Le reste suit le même moule.
const INTRO_CAPTIONS = [
  "je teste mon football sur snapchat",
  "je drague la plus belle du lycée *prenez des notes*",
  "comment dm sur insta (prenez des notes les gars)",
  "comment gérer une meuf sur insta",
  "regarde comment je gère mon football",
  "je gère cette 10/10 par message",
  "je dm ma crush",
  "regarde comment je gère ce pain",
  "je gère mon football par message",
  "regarde comment je dm cette 10/10",
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
  structureOrder: Structure[]; structureIndex: number;
  toneOrder: Tone[]; toneIndex: number;
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
    structureOrder: shuffle(STRUCTURES), structureIndex: 0,
    toneOrder: shuffle([...tones]), toneIndex: 0,
  });
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
    const ok =
      Array.isArray(s.girlOrder) && s.girlOrder.length === girlFiles.length &&
      Array.isArray(s.storyAngleOrder) && s.storyAngleOrder.length === ACTIVE_STORY_ANGLES.length &&
      Array.isArray(s.outroAngleOrder) && s.outroAngleOrder.length === OUTRO_ANGLES.length &&
      Array.isArray(s.archetypeOrder) && s.archetypeOrder.length === ACTIVE_ARCHETYPES.length &&
      Array.isArray(s.captionOrder) && s.captionOrder.length === INTRO_CAPTIONS.length &&
      Array.isArray(s.musicOrder) && s.musicOrder.length === MUSIC_KEYS.length &&
      Array.isArray(s.structureOrder) && s.structureOrder.length === STRUCTURES.length &&
      Array.isArray(s.toneOrder) && s.toneOrder.length === tones.length;
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
// TACOTAC_STRUCTURE=A|B force le format pour ce run (utile pour tester un seul
// des deux sans consommer plusieurs générations). Vide = rotation normale.
const FORCED_STRUCTURE = (process.env.TACOTAC_STRUCTURE || "").toUpperCase();
function nextStructure(state: State): Structure {
  if (FORCED_STRUCTURE === "A" || FORCED_STRUCTURE === "B") return FORCED_STRUCTURE;
  if (state.structureIndex >= state.structureOrder.length) {
    state.structureOrder = shuffle(STRUCTURES);
    state.structureIndex = 0;
  }
  const st = state.structureOrder[state.structureIndex];
  state.structureIndex++;
  saveState(state);
  return st;
}
// Le ton de la CHUTE, en rotation forcée. Laissé au modèle, il convergeait
// systématiquement sur "romantique" (3 vidéos sur 3 au dernier run) : les
// screenshots Classe / Spicy / Sexto de l'app ne sortaient donc quasiment jamais,
// alors que c'est justement la démo du produit.
function nextTone(state: State): Tone {
  if (state.toneIndex >= state.toneOrder.length) {
    state.toneOrder = shuffle([...tones]);
    state.toneIndex = 0;
  }
  const t = state.toneOrder[state.toneIndex];
  state.toneIndex++;
  saveState(state);
  return t;
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
function buildGenInstruction(angles: { story: string; outro: string; archetype: string }, structure: Structure, tone: Tone): string {
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
  // Deux formats de vidéo, tirés en alternance (voir STRUCTURES) :
  //  A — il répond à la story lui-même, puis Tacotac lui souffle LA réplique
  //  B — Tacotac écrit le tout premier DM, puis la réplique juste après
  // Dans les deux cas la vidéo se termine sur un COMPLIMENT d'elle, pas sur un
  // date : le compliment prouve que la disquette a marché et tient en 2 messages,
  // là où un date déclenche une négociation logistique qui rallonge pour rien.
  const her = REVERSED ? "le mec" : "la fille";
  const him = REVERSED ? "la cliente" : "le client";
  const commonBeats = `  • {"kind":"message","from":"girl"|"client","text":"..."}${REVERSED ? ' — ici "girl" = le mec dragué (bulle gauche), "client" = la cliente Tacotac (bulle droite).' : ""}
  • {"kind":"tacotac","tone":"<ton>","text":"..."} — ${him} ouvre l'app. DOIT être suivi IMMÉDIATEMENT d'un {"kind":"message","from":"client","text":"..."} avec EXACTEMENT le même texte.
  • {"kind":"meme","asset":"<nom-de-fichier-exact>"} — vise environ UN MEME POUR DEUX MESSAGES (2 à 3 sur la vidéo). Pas entre chaque message, mais assez pour rythmer. Choisis le fichier qui colle LE MIEUX à ce qui vient d'être dit.
- ⚠️ RAPPEL : amorce 45 caractères max, relance 4 mots max, chute 65 caractères max. Compte-les avant de valider.
- ⚠️ RAPPEL : la relance de ${her} ("non pourquoi ?") n'est PAS un message creux interdit — c'est le pivot de la mécanique. C'est la SEULE exception à la règle "pas de message creux".
- ⚠️ Le storyReply fait 60 CARACTÈRES MAXIMUM, une seule idée lui aussi. "tu postes ça un dimanche soir en sachant très bien ce que ça fait aux gens, assume au moins" = beaucoup trop long, coupe.
- ⚠️ Les messages de la conv sont COURTS eux aussi : une ligne, comme un vrai DM. Jamais deux idées dans un message.
- ⚠️ ÉCRIS AVEC LES ACCENTS. "reponds", "gerer", "deja", "meme" sans accent = faute visible à l'écran. On écrit en phonétique relâchée (jsuis, jte, tkt), PAS sans accents.
- ⛔ LA FIN — 40 CARACTÈRES MAX, UNE SEULE IDÉE, PAS DE VIRGULE. "ok tu m'as eue là, l'autre il peut ranger ses affaires" = deux idées, on ne comprend plus qui est "l'autre" : coupe après "ok tu m'as eue là". Le compliment referme la vidéo, il ne raconte pas une histoire.
- ⛔ LA FIN — varie le compliment. Les 4 dernières vidéos finissaient TOUTES sur "ok là t'es fort". C'est mort, trouve autre chose : "t'es mignon toi", "ok tu m'as eue", "jm'attendais pas à ça", "bon t'as gagné", "arrête jvais rougir", "c'est malin ça". Le compliment doit sonner comme ELLE, pas comme une formule.
- ⛔ Sujets INTERDITS (ils sont revenus dans 1 vidéo sur 4, on n'en veut plus) : le profil fake, les photos truquées, les filtres, demander/donner une preuve que c'est bien lui. Trouve autre chose.
- Fin OBLIGATOIRE : le tout dernier beat est un message de ${her} qui COMPLIMENTE ${him} — du genre "t'es trop fort", "ok t'es mignon toi", "t'as gagné là". Pas de date, pas de numéro, pas de snap : la vidéo s'arrête sur le compliment, c'est ça la preuve que la disquette a marché.
- girlName : prénom crédible${REVERSED ? " pour LE MEC dragué (le champ s'appelle « girlName » mais tient ici le prénom du mec)" : ""}. status : ex "en ligne il y a 2h".`;

  const structureRules =
    structure === "B"
      ? `RÈGLES DE STRUCTURE — FORMAT "DM" (${him} n'a jamais parlé à ${her} avant) :
- storyReply : laisse une chaîne VIDE "". Ce format ne répond à aucune story.
- La vidéo s'ouvre sur la PHOTO de ${her} en plein écran (ajoutée automatiquement, tu n'as rien à écrire pour ça).
- beats : 7 à 9 éléments, dans CET ordre — c'est la MÉCANIQUE EN 3 TEMPS, respecte-la à la lettre :
  1. {"kind":"meme","asset":"..."} — la RÉACTION en voyant sa photo : choisis un meme qui bave / affamé / coquin / sous le charme. C'est le premier beat, obligatoire.
  2. {"kind":"tacotac",...} — l'outil DM écrit **L'AMORCE** (45 car. max, incompréhensible seule)
  3. {"kind":"message","from":"client"} — le même texte, envoyé
  4. {"kind":"message","from":"girl"} — **LA RELANCE** : 4 MOTS MAX, aucune vanne ("non pourquoi ?", "de quoi")
  5. {"kind":"tacotac",...} — l'outil Réplique écrit **LA CHUTE** (65 car. max, image archi-connue)
  6. {"kind":"message","from":"client"} — le même texte, envoyé
  7. {"kind":"message","from":"girl"} — son COMPLIMENT, et la vidéo s'arrête là
${commonBeats}`
      : `RÈGLES DE STRUCTURE — FORMAT "STORY" :
- storyReply : le TOUT PREMIER message de ${him}, en réponse à la story de ${her}. Écrit par ${him} lui-même, PAS par Tacotac.
- beats : 6 à 8 éléments, dans CET ordre — c'est la MÉCANIQUE EN 3 TEMPS, respecte-la à la lettre :
  1. {"kind":"message","from":"girl"} — sa réponse au storyReply
  2. {"kind":"message","from":"client"} — **L'AMORCE** : 45 car. max, elle ne veut rien dire toute seule
  3. {"kind":"message","from":"girl"} — **LA RELANCE** : 4 MOTS MAX, aucune vanne ("non pourquoi ?", "à quoi", "de quoi")
  4. {"kind":"tacotac",...} — Tacotac écrit **LA CHUTE**, le message qui referme (65 car. max, image archi-connue)
  5. {"kind":"message","from":"client"} — le même texte, envoyé
  6. {"kind":"message","from":"girl"} — son COMPLIMENT, et la vidéo s'arrête là
${commonBeats}`;
  return `Tu génères le SCÉNARIO d'une vidéo TikTok "fausse conversation de dating" qui fait la promo de Tacotac (l'app qui souffle les disquettes).

${format}
⛔ INTERDIT : les mots "match"/"matché"/"on a matché" ou toute référence à une app de rencontre (Tinder, Hinge, Bumble...) — l'outil est pour du DM Insta/Snap, pas du swipe.

⚠️ ARCHÉTYPE IMPOSÉ POUR CETTE VIDÉO — c'est le FIL CONDUCTEUR de toute la conv, pas juste la 1ère ligne. Construis les beats "message" autour de CET enjeu précis, du début à la résolution en fin de conv :
${angles.archetype}

${qualityRules}

⚠️⚠️ LA DISQUETTE — LIS ÇA DEUX FOIS, C'EST LE CŒUR DU TRAVAIL ⚠️⚠️

**UNE DISQUETTE N'EST PAS UNE PHRASE. C'EST UNE MÉCANIQUE EN 3 TEMPS.**

C'est LA seule chose qui marche, vérifiée sur les vidéos de la chaîne qui ont réellement performé :

  1. L'AMORCE — ${him} lâche une affirmation courte, gonflée, qui ne veut RIEN dire toute seule.
  2. LA RELANCE — ${her} est OBLIGÉE de demander. 1 à 4 mots, neutres, sans esprit.
  3. LA CHUTE — ${him} referme. C'est LÀ que la vanne tombe, et nulle part ailleurs.

Exemples réels (recopie la MÉCANIQUE, jamais les mots) :
  1. "ton père serait pas un voleur"      2. "non pourquoi ?"   3. "parce qu'il a pris les étoiles du ciel pour les mettre dans tes yeux"
  1. "j'espère que t'es forte en premiers secours"   2. "pourquoi tu dis ça ?"   3. "parce que tu viens de me couper le souffle"
  1. "fais attention"                     2. "à quoi"           3. "à force d'être aussi belle jvais finir par m'attacher"
  1. "t'as pas volé quelque chose"        2. "non pourquoi ?"   3. "bah jcrois que si, t'as volé mon cœur"
  1. "ton père serait pas peintre"        2. "non pourquoi"     3. "parce qu'il a fait une œuvre d'art"

POURQUOI ça marche, et pourquoi c'est NON NÉGOCIABLE : le viewer lit l'amorce, il se pose la même question qu'elle, il ATTEND la réponse. Quand la chute arrive, il n'a aucun effort à faire — c'est une réponse à une question qu'il vient de lire. Zéro décodage. Une punchline balancée d'un seul bloc, elle, oblige à tout démêler d'un coup : c'est exactement ce qu'on ne veut plus.

✅ LES RÈGLES DURES — non négociables :
1. **L'AMORCE : 45 caractères max**, et elle doit être INCOMPLÈTE. Test : lue seule, elle ne doit pas avoir de sens. Si on peut y répondre autre chose que "pourquoi ?", elle est ratée.
2. **LA RELANCE : 4 MOTS MAXIMUM, et elle ne fait AUCUNE vanne.** "non pourquoi ?", "pourquoi", "de quoi", "à quoi", "et donc ?", "quel film ?". Elle est un tremplin, pas une partenaire de banter. Si elle réplique avec de l'esprit ici, la chute tombe à plat.
3. **LA CHUTE : 65 caractères max, UNE SEULE PROPOSITION.** Commence le plus souvent par "parce que" / "bah" — c'est une réponse, elle doit sonner comme une réponse.
4. **LA CHUTE UTILISE UNE IMAGE ARCHI-CONNUE.** Voler mon cœur, couper le souffle, les étoiles dans les yeux, une œuvre d'art, tomber, s'attacher, le Titanic. **N'ESSAIE PAS D'ÊTRE ORIGINAL SUR L'IMAGE** — le plaisir vient de la variation sur un truc connu, pas de la surprise intellectuelle. C'est un compliment déguisé en devinette, rien de plus.
5. **LA CHUTE DOIT RÉPONDRE GRAMMATICALEMENT À LA RELANCE.** Relis-la à voix haute enchaînée avec la relance : ça doit se dire naturellement.
   ✗ "attention avec ce genre de question" / "attention à quoi" / "**parce que** jsuis du genre à m'attacher" ← on répond "parce que" à un "à quoi", ça ne s'enchaîne pas
   ✓ "attention avec ce genre de question" / "attention à quoi" / "**à moi**, jsuis du genre à m'attacher pour moins"
   Règle simple : "pourquoi ?" appelle "parce que…" ou "bah…" — "à quoi ?" appelle "à…" — "de quoi ?" appelle "de…".
6. **VOCABULAIRE 100 % COURANT.** Aucun mot que tu n'entendrais pas dans une cour de récré. Zéro concept abstrait (la vérité, le classement, le rythme, la comparaison, une raison, l'intention).
7. Pas de "…" à la fin.

⛔ CE QUI TUE LES DISQUETTES (analyse réelle des 30 dernières, elles étaient TOUTES malades) :
- Elles étaient BALANCÉES D'UN SEUL BLOC, sans amorce ni relance. C'est le défaut de fond.
- Longueur moyenne 85 caractères, 97 % avec une virgule → deux idées → illisible au scroll.
- Le poison n°1 : le retournement conceptuel du type "t'es pas en train de me tester, t'es en train de vérifier si jtiens le rythme" ou "jhésitais entre un truc banal et la vérité, jai choisi le pire des deux". Ça a l'air malin, ça ne veut RIEN dire à la lecture rapide. N'écris PLUS JAMAIS ce genre de construction.

EXEMPLES DE CE QU'ON NE VEUT PLUS (vraies disquettes ratées : trop longues, alambiquées, et sans mécanique) :
  ✗ "jveux pas être en tête de ton classement, jveux juste que tu supprimes le classement"
  ✗ "ton physique m'a fait ouvrir, ta question m'a fait rester, le reste tu le sauras en vrai"
  ✗ "pas bavarde jaime bien, ça veut dire que quand tu diras un truc jvais le prendre au sérieux"

- La chute doit rester VOLABLE : le viewer doit pouvoir la ressortir telle quelle dans sa conv. Donc aucun détail propre à CETTE conv.
- INTERDIT aussi : les questions molles ("t'as passé une bonne journée ?"), les compliments secs ("t'es trop belle").

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

⚠️ TON IMPOSÉ POUR CETTE VIDÉO : **${tone}** — mets exactement "${tone}" dans le champ "tone" de CHAQUE beat tacotac, et surtout ÉCRIS la chute dans ce registre :
${TONE_BRIEFS[tone]}
(Le ton est choisi par le code en rotation, pas par toi : n'en prends pas un autre. Mais la mécanique amorce → relance → chute reste la même quel que soit le ton.)
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

function callCli(angles: { story: string; outro: string; archetype: string }, structure: Structure, tone: Tone): GenOutput {
  const prompt = `${systemPromptTacotac}\n\n═══════════\n${buildGenInstruction(angles, structure, tone)}\n\n${jsonShape}\n\nGénère un nouveau scénario, original et drôle.`;
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
async function callApi(angles: { story: string; outro: string; archetype: string }, structure: Structure, tone: Tone): Promise<GenOutput> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const params: Record<string, unknown> = {
    model: "claude-opus-4-8",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: `${systemPromptTacotac}\n\n═══════════\n${buildGenInstruction(angles, structure, tone)}`,
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

function assemble(g: GenOutput, state: State, structure: Structure, forcedTone: Tone) {
  const girl = nextGirl(state);
  const introCaption = nextIntroCaption(state);
  const music = nextMusic(state);
  // Quel écran de l'app montrer : en format B le PREMIER moment Tacotac est le DM
  // d'ouverture, tous les suivants sont des réponses. En format A, tout est réponse.
  // Dérivé par le code (le modèle ne choisit pas les assets — même règle que les memes).
  let seenTacotac = 0;
  const beats = g.beats.map((b) => {
    if (b.kind === "message") return { type: "message", from: b.from, text: clean(b.text) };
    if (b.kind === "tacotac") {
      const tool = structure === "B" && seenTacotac === 0 ? "dm" : "reply";
      seenTacotac++;
      return { type: "tacotac", tone: forcedTone, text: clean(b.text), tool };
    }
    const { full, beat } = resolveMemeAsset(b.asset);
    return { type: "meme", asset: full, beat };
  });
  return {
    id: `vid_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    girl: { name: g.girlName, avatar: girl, status: g.status, storyThumbnail: girl },
    // Format B : la conv démarre sur le DM d'ouverture, il n'y a aucune story à
    // laquelle répondre — on retire le bandeau "Vous avez répondu à sa story".
    storyReply: structure === "B" ? undefined : clean(g.storyReply) || undefined,
    // Format B : la vidéo ouvre sur SA photo (la même que l'avatar de la conv),
    // puis le meme de réaction, puis l'écran DM de l'app.
    openPhoto: structure === "B" ? girl : undefined,
    // Titre incrusté sur l'intro, tiré en rotation par le code (voir INTRO_CAPTIONS).
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

// Le prompt demande la mécanique en 3 temps (amorce → relance → chute) ; ces
// contrôles la GARANTISSENT. Sans eux le modèle dérive vers la punchline balancée
// d'un seul bloc, à 85 caractères de moyenne et deux propositions par phrase —
// illisible au scroll, c'est le défaut n°1 remonté sur les vidéos.
const MAX_PUNCHLINE_CHARS = 65; // la CHUTE (le dernier écran Tacotac)
const MAX_AMORCE_CHARS = 45; // une amorce Tacotac (format B) : encore plus court
const MAX_RELANCE_WORDS = 4; // "non pourquoi ?" — au-delà, elle vole la vedette à la chute
const MAX_FIN_CHARS = 40; // le compliment de fin : une seule idée, il referme, c'est tout
const MAX_STORY_CHARS = 60; // l'ouverture a droit à un peu plus, mais pas au pavé
type Candidate = ReturnType<typeof assemble>;
function punchlineProblems(script: Candidate): string[] {
  const problems: string[] = [];
  const beats = script.beats;
  // Le DERNIER écran Tacotac porte la chute ; les précédents (format B) l'amorce.
  const lastTacotac = beats.map((b) => b.type).lastIndexOf("tacotac");

  beats.forEach((b, i) => {
    if (b.type !== "tacotac" || typeof b.text !== "string") return;
    const isChute = i === lastTacotac;
    const max = isChute ? MAX_PUNCHLINE_CHARS : MAX_AMORCE_CHARS;
    if (b.text.length > max) {
      problems.push(`${isChute ? "chute" : "amorce"} ${b.text.length} car (max ${max}) : "${b.text}"`);
    }
  });

  // La mécanique elle-même : la chute doit RÉPONDRE à une relance courte d'elle.
  // Sans ce contrôle le modèle retombe sur "elle fait une vanne puis il en fait une".
  if (lastTacotac > 0) {
    // On remonte en sautant les memes : un meme glissé entre la relance et la
    // chute ne casse pas la mécanique (il fait même monter l'attente), mais il
    // faisait échouer le contrôle et déclenchait des régénérations pour rien.
    let j = lastTacotac - 1;
    while (j >= 0 && beats[j].type === "meme") j--;
    const before = beats[j];
    if (!before || before.type !== "message" || before.from !== "girl") {
      problems.push("la chute n'est pas precedee d'une relance de la fille (mecanique en 3 temps cassee)");
    } else {
      const words = before.text.trim().split(/\s+/).length;
      if (words > MAX_RELANCE_WORDS) {
        problems.push(`relance ${words} mots (max ${MAX_RELANCE_WORDS}) : "${before.text}"`);
      }
    }
  }

  // Le compliment final : il referme la vidéo, il ne raconte pas une 2e histoire.
  // Sans ce contrôle il dérivait vers deux propositions séparées par une virgule.
  const last = beats[beats.length - 1];
  if (last?.type === "message" && last.from === "girl" && last.text.length > MAX_FIN_CHARS) {
    problems.push(`compliment final ${last.text.length} car (max ${MAX_FIN_CHARS}) : "${last.text}"`);
  }

  if (script.storyReply && script.storyReply.length > MAX_STORY_CHARS) {
    problems.push(`storyReply ${script.storyReply.length} car (max ${MAX_STORY_CHARS}) : "${script.storyReply}"`);
  }
  return problems;
}

async function generateOne(backend: "cli" | "api", state: State) {
  let script: Candidate | null = null;
  let fallback: Candidate | null = null; // meilleur candidat vu, si aucun n'est parfait
  // Angles et format tirés UNE SEULE FOIS pour cette vidéo : une régénération
  // corrige un texte non conforme, elle ne doit pas changer le sujet ni sauter au
  // format suivant (sinon un run "format DM" pouvait ressortir en format story, et
  // chaque essai raté brûlait un cran de rotation).
  const angles = nextAngles(state); // 1 angle différent par champ, jamais répété avant d'avoir tout épuisé
  const structure = nextStructure(state);
  const tone = nextTone(state); // ton imposé au modèle ET au rendu, voir nextTone()
  for (let attempt = 1; attempt <= MAX_LENGTH_RETRIES; attempt++) {
    const g = backend === "api" ? await callApi(angles, structure, tone) : callCli(angles, structure, tone);
    const candidate = assemble(g, state, structure, tone);
    scriptSchema.parse(candidate); // rejette tout scénario invalide (compat render)
    const secs = durationSeconds(scriptSchema.parse(candidate));
    const tooLong = punchlineProblems(candidate);
    if (secs <= MAX_DURATION_SECONDS && tooLong.length === 0) {
      script = candidate;
      console.log(`   durée ${secs.toFixed(1)}s ✅  mécanique amorce→relance→chute ✅`);
      break;
    }
    // On garde le 1er candidat valide en durée : mieux vaut une disquette un peu
    // longue qu'un run qui plante et zéro vidéo produite.
    if (secs <= MAX_DURATION_SECONDS && !fallback) fallback = candidate;
    if (secs > MAX_DURATION_SECONDS) {
      console.warn(`   ⚠️ ${secs.toFixed(1)}s > ${MAX_DURATION_SECONDS}s — régénération (${attempt}/${MAX_LENGTH_RETRIES})`);
    } else {
      console.warn(`   ⚠️ disquette non conforme — régénération (${attempt}/${MAX_LENGTH_RETRIES})`);
      for (const p of tooLong) console.warn(`      ${p}`);
    }
  }
  if (!script && fallback) {
    console.warn(`   ⚠️ aucun scénario parfait après ${MAX_LENGTH_RETRIES} essais — on garde le moins mauvais`);
    script = fallback;
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
  for (const st of STRUCTURES) scriptSchema.parse(assemble(fake, state, st));
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

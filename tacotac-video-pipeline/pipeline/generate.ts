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

// Meme "il prépare son coup", inséré par le CODE juste avant l'écran DM, pas
// choisi par le modèle — même principe que tool/tone/musique : un placement
// structurel fixe, en rotation, ne doit jamais dépendre de ce que le modèle
// pense à faire. Validé par Tom le 05/09 (4 memes, pour que ça tourne).
const AVANT_DM_MEMES = library.beats.avant_dm?.memes ?? [];

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
function recentOutputs(limit = 25): { stories: string[]; punchlines: string[]; amorces: string[]; fins: string[] } {
  const stories: string[] = [];
  const punchlines: string[] = [];
  // L'AMORCE (le message qui plante le mot) n'était jamais collectée : en format
  // story c'est un simple beat "message" du client, pas un beat "tacotac". Le
  // modèle ne voyait donc jamais ses propres amorces passées et resservait les
  // mêmes mots — "assurance" 3 fois sur 20, "clim" 2 fois, et 7 amorces sur 20
  // qui commençaient par "faudra/faudrait".
  const amorces: string[] = [];
  // Le compliment final convergeait aussi (2 scripts d'affilee sur "ok toi tu
  // sais parler") : il n'etait pas non plus dans l'historique montre au modele.
  const fins: string[] = [];
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
        const beats = script?.beats ?? [];
        for (const b of beats) {
          if (b?.type === "tacotac" && b.text) punchlines.push(b.text);
        }
        // Même remontée que la validation : dernier tacotac = la chute, on saute
        // les memes et la relance pour retomber sur l'amorce.
        const last = beats.map((b: { type: string }) => b.type).lastIndexOf("tacotac");
        if (last > 0) {
          let a = last - 1;
          while (a >= 0 && beats[a].type === "meme") a--;
          a--;
          while (a >= 0 && beats[a].type === "meme") a--;
          if (a >= 0 && beats[a]?.text) amorces.push(beats[a].text);
        }
        const der = beats[beats.length - 1];
        if (der?.type === "message" && der.from === "girl" && der.text) fins.push(der.text);
      } catch { /* fichier illisible : on l'ignore, l'anti-répétition reste best-effort */ }
    }
  } catch { /* pas encore d'archive (1er run) */ }
  return { stories, punchlines, amorces, fins };
}

function buildAvoidBlock(): string {
  const { stories, punchlines, amorces, fins } = recentOutputs();
  if (!stories.length && !punchlines.length && !amorces.length) return "";
  const list = (arr: string[], max: number) =>
    arr.slice(0, max).map((s) => `- ${s}`).join("\n");
  return `

⛔ DÉJÀ SORTI DANS LES VIDÉOS PRÉCÉDENTES — INTERDIT DE RÉUTILISER
Ne reprends ni ces formulations, ni le RESSORT COMIQUE qu'il y a derrière (même
idée reformulée = même faute). Si ton brouillon ressemble à l'un de ces exemples,
jette-le et trouve un autre angle.

⛔ Et surtout : NE REPRENDS AUCUN DES MOTS PLANTÉS ci-dessous. Si "assurance" est
déjà sorti, tu ne fais pas une autre vanne sur l'assurance — tu changes carrément
de domaine.

Amorces déjà utilisées (regarde le MOT PLANTÉ dans chacune) :
${list(amorces, 25)}

storyReply déjà utilisés :
${list(stories, 25)}

Disquettes déjà utilisées :
${list(punchlines, 25)}

Compliments de fin déjà utilisés (trouve autre chose, ne resers pas le même) :
${list(fins, 20)}`;
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
// ⚠️ Répondre à une story, C'EST envoyer un DM à une meuf qu'on ne connaît pas
// vraiment. Le message doit donc tenir tout seul comme premier DM : il ne parle
// JAMAIS de la story ni du fait de l'avoir postée.
//
// L'ancien pool faisait exactement l'inverse : 6 angles sur 10 ordonnaient de
// commenter l'acte de poster ("elle savait l'effet que ça allait faire", "son
// intention en postant ça", "le concept même de poster une story"…) pendant que
// le prompt l'interdisait par ailleurs. L'angle imposé gagnait : 8 des 15
// dernières vidéos commentaient le fait de poster, dont "toi tu savais très bien
// ce que tu faisais en postant ça" — le 1er angle, mot pour mot.
// ⚠️ AUCUN exemple entre parenthèses dans ce pool. Le modèle les recopie mot pour
// mot : "t'as tout du genre de meuf qui..." et "t'as l'énergie de..." venaient de
// MES propres parenthèses et sont ressortis 6 fois sur 15. On décrit le MOUVEMENT,
// jamais la formulation.
const STORY_REPLY_ANGLES = [
  "une accusation taquine et complètement inventée, qu'il assume avec un calme total",
  "un reproche à l'envers : il lui reproche un truc qui est en fait un compliment",
  "une fausse mise en garde contre lui-même, comme s'il était le danger",
  "une fausse indifférence jouée, presque blasé — l'inverse total de s'extasier",
  "un défi léger qui l'oblige à se positionner tout de suite",
  "une question directe et culottée à laquelle on ne peut pas répondre par oui ou non",
  "une remarque sur SON comportement à elle dans la conv (son temps de réponse, sa façon d'écrire), jamais sur son physique",
  "un pari qu'il annonce et qu'elle voudra faire échouer",
  "une conclusion absurde qu'il tire d'un détail minuscule, avec un sérieux total",
  "un compliment qui bascule en vanne à la toute fin de la phrase",
];
// Même registre que STORY_REPLY_ANGLES, pronoms inversés (elle → il) pour le profil
// "rôles inversés" (la cliente répond à SA story à LUI).
const STORY_REPLY_ANGLES_REVERSED = [
  "une accusation taquine et complètement inventée, qu'elle assume avec un calme total",
  "un reproche à l'envers : elle lui reproche un truc qui est en fait un compliment",
  "une fausse mise en garde contre elle-même, comme si elle était le danger",
  "une fausse indifférence jouée, presque blasée — l'inverse total de s'extasier",
  "un défi léger qui l'oblige à se positionner tout de suite",
  "une question directe et culottée à laquelle on ne peut pas répondre par oui ou non",
  "une remarque sur SON comportement à lui dans la conv (son temps de réponse, sa façon d'écrire), jamais sur son physique",
  "un pari qu'elle annonce et qu'il voudra faire échouer",
  "une conclusion absurde qu'elle tire d'un détail minuscule, avec un sérieux total",
  "un compliment qui bascule en vanne à la toute fin de la phrase",
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
  "elle a du caractère et ne se laisse pas mener, elle le reprend quand il va trop vite",
  "elle est intriguée mais garde ses distances, il doit la faire lâcher prise sans forcer",
  "long silence de sa part puis elle relance elle-même, ou l'inverse — le client relance après un silence sans être lourd",
  "elle le vanne sur un détail (son look, sa réplique, son âge...) et le banter monte crescendo en complicité",
  "elle pose une question piège sur ce qu'il veut vraiment, il doit répondre avec assurance sans fuir ni se justifier",
  "elle change de sujet ou évite une question, le client doit rebondir sans s'accrocher ni paraître vexé",
];
// Même registre que CONVERSATION_ARCHETYPES, rôles inversés : lui teste/négocie/hésite,
// la cliente (Amelia) mène la conv et l'assure — jamais elle qui doute d'elle-même.
const CONVERSATION_ARCHETYPES_REVERSED = [
  "il dit qu'il est occupé / qu'il a pas le temps, elle ne le supplie pas et retourne ça en sa faveur",
  "il est froid et distant au début (réponses courtes, presque désintéressé), et se réchauffe progressivement au fil de la conv",
  "il a du caractère et ne se laisse pas mener, il le reprend quand elle va trop vite",
  "il est intrigué mais garde ses distances, elle doit le faire lâcher prise sans forcer",
  "long silence de sa part puis il relance lui-même, ou l'inverse — la cliente relance après un silence sans être lourde",
  "il la vanne sur un détail (son look, sa réplique, son âge...) et le banter monte crescendo en complicité",
  "il pose une question piège sur ce qu'elle veut vraiment, elle doit répondre avec assurance sans fuir ni se justifier",
  "il change de sujet ou évite une question, la cliente doit rebondir sans s'accrocher ni paraître vexée",
];

// Musiques disponibles (voir src/music.ts) — chacune embarque SA coupe d'intro pour
// que le panier tombe sur le drop. Tirées en rotation comme le reste : sans ça, le
// champ script.music restait vide et le rendu retombait toujours sur bg-music.
// Playlist imposée à un profil : il n'aura QUE ces musiques. ANOMY tourne
// exclusivement sur "pistolet" (son son de signature, et la seule dont l'intro
// est accélérée — c'est ce qui rend ses vidéos reconnaissables).
// Les autres profils gardent le catalogue COMPLET, pistolet incluse : Tom veut
// pouvoir l'utiliser aussi, elle n'est pas réservée, juste imposée à anomy.
const MUSIC_BY_PROFILE: Record<string, string[]> = { anomy: ["pistolet"] };
const MUSIC_KEYS = MUSIC_BY_PROFILE[PROFILE] ?? Object.keys(MUSIC_TRACKS);

// Un seul format actif : B — Tacotac écrit le 1er DM (outil "DM") PUIS la
// réplique (outil "Réplique"), les 2 outils sont montrés à l'écran.
// Format A retiré le 05/09/26 sur demande de Tom : son amorce était écrite
// directement comme un message normal, JAMAIS via l'outil DM — donc la moitié
// de la vidéo ne montrait pas le produit, et cette amorce "libre" (pas tenue
// à la même barre de qualité qu'un vrai beat tacotac) sortait souvent faible
// ("souvent des phrases bidons"). Le type garde "A" pour ne pas casser les
// scripts déjà en file/rendus qui le référencent encore, mais plus aucune
// nouvelle vidéo ne peut le tirer.
type Structure = "A" | "B";
const STRUCTURES: Structure[] = ["B"];

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
// ⛔ JAMAIS "snapchat" ici : le décor rendu dans la vidéo est une conv Instagram.
// Un titre "sur snapchat" au-dessus d'un écran Insta se voit immédiatement.
//
// Le CODE ne tire plus le titre au hasard : il envoie toute la liste au modèle,
// qui choisit celui qui colle le mieux au scénario qu'il vient d'écrire (voir la
// consigne "TITRE" dans le prompt). Un titre tiré au sort tombait régulièrement à
// côté (« je dm ma crush » sur une réponse à story).
const INTRO_CAPTIONS_CLASSIQUES = [
  "je teste mon football sur insta",
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
// Titres "second degré" : purement là pour faire réagir dans les commentaires
// ("attends quoi ??"). Ce sont des APPÂTS — la conv en dessous ne doit JAMAIS y
// faire référence (voir la règle dans le prompt), sinon la vanne tombe à plat et
// ça devient une histoire bizarre au premier degré.
const INTRO_CAPTIONS_DROLES = [
  "je dm la sœur de mon pote",
  "je drague la demi sœur de mon demi frère",
  "je dm la meilleure amie de ma sœur",
  "je dm la fille de mon père",
  "je drague la cousine de ma sœur",
  "je dm la meuf à mon frère",
  "je drague la fille de ma belle mère",
];
// Laissé au modèle, le choix ENTRE les deux pools convergeait vers zéro titre
// "second degré" (aucun en plusieurs dizaines de vidéos) — probablement le
// modèle qui évite de lui-même des titres évoquant des liens familiaux, même
// utilisés comme vanne. Même remède que pour nextTone() : le CODE force le
// pool en rotation (proportionnelle à leur taille), le modèle choisit
// seulement LEQUEL dans le pool imposé colle le mieux au scénario.
type IntroPool = "classique" | "drole";

// Profil "rôles inversés" (solene/Amelia) : c'est ELLE qui drague UN MEC. Les
// titres normaux ciblaient une fille ("la plus belle", "une meuf") — publiés tels
// quels sur ses vidéos, ils contredisaient l'histoire à l'écran. Cibles masculinisées.
// Volontairement SANS les titres second degré : Tom ne les veut que pour lui/anomy.
const INTRO_CAPTIONS_CLASSIQUES_REVERSED = [
  "je teste mon football sur insta",
  "je drague le plus beau du lycée *prenez des notes*",
  "comment dm sur insta (prenez des notes les meufs)",
  "comment gérer un mec sur insta",
  "regarde comment je gère mon football",
  "je gère ce 10/10 par message",
  "je dm ma crush",
  "regarde comment je gère ce pain",
  "je gère mon football par message",
  "regarde comment je dm ce 10/10",
];

// Pools actifs pour ce profil (droits pour "solene"/Amelia, par défaut sinon).
const ACTIVE_STORY_ANGLES = REVERSED ? STORY_REPLY_ANGLES_REVERSED : STORY_REPLY_ANGLES;
const ACTIVE_ARCHETYPES = REVERSED ? CONVERSATION_ARCHETYPES_REVERSED : CONVERSATION_ARCHETYPES;
// Côté "classique" seulement — le pool "drole" n'a pas de variante REVERSED,
// il est simplement jamais tiré pour ce profil (voir nextIntroPool).
const ACTIVE_INTRO_CAPTIONS_CLASSIQUES = REVERSED ? INTRO_CAPTIONS_CLASSIQUES_REVERSED : INTRO_CAPTIONS_CLASSIQUES;

// ── Rotation générique : jamais de doublon avant d'avoir épuisé tout le pool ──
// (corrige le bug "2 fois la même fille" observé sur un batch de 5 vidéos —
// même mécanique réutilisée pour les angles d'écriture ci-dessus).
type State = {
  girlOrder: string[]; girlIndex: number;
  storyAngleOrder: string[]; storyAngleIndex: number;
  outroAngleOrder: string[]; outroAngleIndex: number;
  archetypeOrder: string[]; archetypeIndex: number;
  captionClassiqueOrder: string[]; captionClassiqueIndex: number;
  captionDroleOrder: string[]; captionDroleIndex: number;
  introPoolOrder: IntroPool[]; introPoolIndex: number;
  musicOrder: string[]; musicIndex: number;
  structureOrder: Structure[]; structureIndex: number;
  toneOrder: Tone[]; toneIndex: number;
  avantDmOrder: string[]; avantDmIndex: number;
};
// 10 "classique" + 7 "drole" (taille réelle des pools) : sur un cycle complet,
// chaque titre drôle sort exactement une fois, ni plus ni moins souvent que prévu.
const introPoolTags = (): IntroPool[] => [
  ...Array<IntroPool>(INTRO_CAPTIONS_CLASSIQUES.length).fill("classique"),
  ...Array<IntroPool>(INTRO_CAPTIONS_DROLES.length).fill("drole"),
];
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
    captionClassiqueOrder: shuffle(ACTIVE_INTRO_CAPTIONS_CLASSIQUES), captionClassiqueIndex: 0,
    captionDroleOrder: shuffle(INTRO_CAPTIONS_DROLES), captionDroleIndex: 0,
    introPoolOrder: shuffle(introPoolTags()), introPoolIndex: 0,
    musicOrder: shuffle(MUSIC_KEYS), musicIndex: 0,
    structureOrder: shuffle(STRUCTURES), structureIndex: 0,
    toneOrder: shuffle([...tones]), toneIndex: 0,
    avantDmOrder: shuffle(AVANT_DM_MEMES), avantDmIndex: 0,
  });
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
    // Le state stocke les TEXTES eux-mêmes, pas des index : si on corrige un
    // libellé dans le code sans changer la taille du pool, l'ancienne version
    // continuait de ressortir tant que la rotation n'était pas épuisée (vu avec
    // le titre "…sur snapchat" alors que le décor rendu est Instagram).
    // On vérifie donc aussi que chaque entrée existe TOUJOURS dans le pool.
    const sameSet = (stored: unknown, pool: readonly string[]) =>
      Array.isArray(stored) && stored.length === pool.length && stored.every((v) => pool.includes(v as string));
    const ok =
      sameSet(s.girlOrder, girlFiles) &&
      sameSet(s.storyAngleOrder, ACTIVE_STORY_ANGLES) &&
      sameSet(s.outroAngleOrder, OUTRO_ANGLES) &&
      sameSet(s.archetypeOrder, ACTIVE_ARCHETYPES) &&
      sameSet(s.captionClassiqueOrder, ACTIVE_INTRO_CAPTIONS_CLASSIQUES) &&
      sameSet(s.captionDroleOrder, INTRO_CAPTIONS_DROLES) &&
      Array.isArray(s.introPoolOrder) && s.introPoolOrder.length === introPoolTags().length &&
      sameSet(s.musicOrder, MUSIC_KEYS) &&
      sameSet(s.structureOrder, STRUCTURES) &&
      sameSet(s.toneOrder, tones) &&
      sameSet(s.avantDmOrder, AVANT_DM_MEMES);
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
function nextAvantDmMeme(state: State): string | undefined {
  if (AVANT_DM_MEMES.length === 0) return undefined;
  if (state.avantDmIndex >= state.avantDmOrder.length) {
    state.avantDmOrder = shuffle(AVANT_DM_MEMES);
    state.avantDmIndex = 0;
  }
  const m = state.avantDmOrder[state.avantDmIndex];
  state.avantDmIndex++;
  saveState(state);
  return m;
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
// Quel POOL pour cette vidéo — voir le commentaire sur IntroPool plus haut.
// Profil REVERSED (solene) : jamais de pool "drole", Tom ne les veut que pour
// lui/anomy — la rotation ne tire donc que dans "classique" pour elle.
function nextIntroPool(state: State): IntroPool {
  if (REVERSED) return "classique";
  if (state.introPoolIndex >= state.introPoolOrder.length) {
    state.introPoolOrder = shuffle(introPoolTags());
    state.introPoolIndex = 0;
  }
  const pool = state.introPoolOrder[state.introPoolIndex];
  state.introPoolIndex++;
  saveState(state);
  return pool;
}
// Titre DANS le pool imposé — utilisé seulement en secours si le modèle sort
// une phrase hors liste (voir assemble()) : le pool, lui, ne change jamais
// après coup, sinon une régénération basculerait un titre drôle en classique.
function nextIntroCaption(state: State, pool: IntroPool): string {
  if (pool === "drole") {
    if (state.captionDroleIndex >= state.captionDroleOrder.length) {
      state.captionDroleOrder = shuffle(INTRO_CAPTIONS_DROLES);
      state.captionDroleIndex = 0;
    }
    const caption = state.captionDroleOrder[state.captionDroleIndex];
    state.captionDroleIndex++;
    saveState(state);
    return caption;
  }
  if (state.captionClassiqueIndex >= state.captionClassiqueOrder.length) {
    state.captionClassiqueOrder = shuffle(ACTIVE_INTRO_CAPTIONS_CLASSIQUES);
    state.captionClassiqueIndex = 0;
  }
  const caption = state.captionClassiqueOrder[state.captionClassiqueIndex];
  state.captionClassiqueIndex++;
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
function buildGenInstruction(angles: { story: string; outro: string; archetype: string }, structure: Structure, tone: Tone, introPool: IntroPool): string {
  const format = REVERSED
    ? `FORMAT : une fille (la cliente, bulles à droite) drague un mec (bulles à gauche) en DM Instagram — PAS une app de rencontre à "match", ils se suivent déjà ou se connaissent un peu. Elle répond à sa story, la conv s'enchaîne, à un moment elle ouvre Tacotac qui lui donne une réplique qui claque, elle l'envoie, ça marche, la conv finit sur une bonne note (il valide / accepte un date). Des memes réactions ponctuent la conv.`
    : `FORMAT : un mec (le client, bulles à droite) drague une fille (bulles à gauche) en DM Instagram — PAS une app de rencontre à "match", ils se suivent déjà ou se connaissent un peu. Il répond à sa story, la conv s'enchaîne, à un moment il ouvre Tacotac qui lui donne une réplique qui claque, il l'envoie, ça marche, la conv finit sur une bonne note (elle valide / accepte un date). Des memes réactions ponctuent la conv.`;
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
- ⛔⛔ ${her.toUpperCase()} EST UNE MEUF NORMALE, PAS UN PERSONNAGE. C'est le truc qui fait le plus "faux" quand c'est raté.
  Elle vient de recevoir un message d'un mec qu'elle ne connaît quasiment pas. Donc :
  ✗ INTERDIT qu'elle parle de DATE, de LIEU, d'HORAIRE ou de "qui décide" dans les 3 premiers messages. Vu en vrai et ça sonne complètement bidon : "ok mais moi je choisis le lieu et la date" en 2e message — aucune fille n'écrit ça à un inconnu.
  ✗ INTERDIT qu'elle annonce elle-même ses conditions, ses règles, ou qu'elle mène le jeu comme une pro de la vanne.
  ✓ Elle répond COURT et normalement : elle est intriguée, ou sceptique, ou occupée, ou elle chambre un peu. Comme quelqu'un qui répond entre deux trucs, pas comme une scénariste.
  ✓ C'est LUI qui a la répartie et qui pousse. Elle, elle réagit.
- ⛔ ${her.toUpperCase()} N'ENVOIE JAMAIS DEUX MESSAGES DE SUITE. Jamais deux beats "girl" consécutifs, nulle part. Deux bulles grises d'affilée = elle se parle à elle-même = on voit tout de suite que la conv est fausse. Elle dit UNE chose, puis elle attend qu'il réponde. Si tu as envie de lui faire dire deux trucs, garde le meilleur et jette l'autre.
  ⛔ Le piège précis à éviter en fin de vidéo : écrire une réplique tiède ("mdrr sympa mais jai vraiment pas le temps la") PUIS ajouter le compliment dans un 2e message. Le compliment doit être son SEUL et unique dernier message.
- ⚠️ ÉCRIS AVEC LES ACCENTS. "reponds", "gerer", "deja", "meme" sans accent = faute visible à l'écran. On écrit en phonétique relâchée (jsuis, jte, tkt), PAS sans accents.
- ⛔ LA FIN — 40 CARACTÈRES MAX, UNE SEULE IDÉE, PAS DE VIRGULE. Le compliment referme la vidéo, il ne raconte pas une histoire.
- ⛔ LA FIN EST UN COMPLIMENT DIRECT SUR LUI, et rien d'autre. Elle dit qu'il est fort ou qu'il est mignon, point. C'est exactement le registre des vidéos qui marchent :
  ✅ "t'es trop fort toi", "ok t'es trop mignon", "arrête jvais rougir", "t'es mignon toi", "ok tu m'as eue", "jm'attendais pas à ça", "bon t'as gagné", "c'est malin ça", "ok toi tu sais parler", "t'as de la répartie toi"
  ⛔ INTERDIT — tout ce qui suppose qu'ils se connaissent déjà ou se sont déjà vus : "tu m'as manqué", "comme d'hab", "ça fait longtemps", "on se revoit quand", "j'ai hâte de te revoir". Ils ne se sont JAMAIS parlé avant cette conv : elle ne peut pas être nostalgique de lui.
  ⛔ INTERDIT aussi : la logistique ("jdois filer", "on en reparle", "envoie ton snap") et tout ce qui n'est pas un compliment. La vidéo s'arrête sur ELLE qui reconnaît qu'il a gagné, pas sur un rendez-vous.
- ⛔ Sujets INTERDITS (ils sont revenus dans 1 vidéo sur 4, on n'en veut plus) : le profil fake, les photos truquées, les filtres, demander/donner une preuve que c'est bien lui. Trouve autre chose.
- Fin OBLIGATOIRE : le tout dernier beat est un message de ${her} qui COMPLIMENTE ${him} — "t'es trop fort toi", "ok t'es trop mignon", "arrête jvais rougir". Pas de date, pas de numéro, pas de snap, aucune logistique : la vidéo s'arrête sur le compliment, c'est ça la preuve que la disquette a marché.
- girlName : prénom crédible${REVERSED ? " pour LE MEC dragué (le champ s'appelle « girlName » mais tient ici le prénom du mec)" : ""}. status : ex "en ligne il y a 2h".`;

  const structureRules =
    structure === "B"
      ? `RÈGLES DE STRUCTURE — FORMAT "DM" (${him} n'a jamais parlé à ${her} avant) :
- storyReply : laisse une chaîne VIDE "". Ce format ne répond à aucune story.
- La vidéo s'ouvre sur la PHOTO de ${her} en plein écran (ajoutée automatiquement, tu n'as rien à écrire pour ça).
⛔⛔ ${him} N'A JAMAIS PARLÉ À ${her}. C'EST LUI QUI ÉCRIT LE PREMIER, TOUJOURS.
Le tout premier message de la conv est donc SON DM à lui. ${her} ne peut PAS parler avant : elle répondrait à un message qui n'existe pas.
⚠️ L'archétype imposé plus haut décrit une situation qui vient d'ELLE ("elle est occupée", "elle mentionne un autre mec"...) : en format DM, elle ne peut l'exprimer QUE dans sa RÉPONSE, jamais dans le premier message. C'est l'erreur qui a été commise 4 fois sur 15 — la vidéo s'ouvrait sur "n'importe quoi jsuis juste hyper occupée" alors que personne ne lui avait rien dit.

- beats : 7 à 9 éléments, dans CET ordre — c'est la MÉCANIQUE EN 3 TEMPS, respecte-la à la lettre :
  1. {"kind":"meme","asset":"..."} — la RÉACTION en voyant sa photo : choisis un meme qui bave / affamé / coquin / sous le charme. C'est le premier beat, obligatoire.
  2. {"kind":"tacotac",...} — l'outil DM écrit **L'AMORCE** (45 car. max, incompréhensible seule). ⚠️ C'EST LE PREMIER TEXTE DE LA CONV : aucun message de ${her} avant lui.
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
⛔ INTERDIT : les mots "match"/"matché"/"on a matché" ou toute référence à une app de rencontre (Tinder, Hinge, Bumble...) — l'outil est pour du DM Insta, pas du swipe.

⚠️ ARCHÉTYPE IMPOSÉ POUR CETTE VIDÉO — c'est le FIL CONDUCTEUR de toute la conv, pas juste la 1ère ligne. Construis les beats "message" autour de CET enjeu précis, du début à la résolution en fin de conv :
${angles.archetype}

${qualityRules}

⚠️⚠️ LA DISQUETTE — LIS ÇA DEUX FOIS, C'EST LE CŒUR DU TRAVAIL ⚠️⚠️

**UNE DISQUETTE N'EST PAS UNE PHRASE. C'EST UNE MÉCANIQUE EN 3 TEMPS.**

C'est LA seule chose qui marche, vérifiée sur les vidéos de la chaîne qui ont réellement performé :

  1. L'AMORCE — ${him} lâche une affirmation courte, gonflée, qui ne veut RIEN dire toute seule.
  2. LA RELANCE — ${her} est OBLIGÉE de demander. 1 à 4 mots, neutres, sans esprit.
  3. LA CHUTE — ${him} referme. C'est LÀ que la vanne tombe, et nulle part ailleurs.

🔑 LE MOTEUR, C'EST UN JEU DE MOTS. PAS UN COMPLIMENT.

L'AMORCE PLANTE UN MOT CONCRET (un métier, un objet, une situation). LA CHUTE RÉVÈLE LE SENS AMOUREUX DE CE MOT. Le mot planté EST la vanne :

  1. "ton père serait pas un voleur"   2. "non pourquoi ?"   3. "parce qu'il a pris les étoiles du ciel pour les mettre dans tes yeux"
     → mot planté : VOLEUR. La chute paie le vol.
  1. "ton père serait pas peintre"   2. "non pourquoi"   3. "parce qu'il a fait une œuvre d'art"
     → mot planté : PEINTRE. La chute paie la peinture.
  1. "j'espère que t'es forte en premiers secours"   2. "pourquoi tu dis ça ?"   3. "parce que tu viens de me couper le souffle"
     → mot planté : PREMIERS SECOURS. La chute paie la respiration.
  1. "jvais devoir appeler les pompiers"   2. "pourquoi"   3. "bah tu viens de me faire fondre"
     → mot planté : POMPIERS. La chute paie le feu.
  1. "t'aurais pas un gps sur toi"   2. "pourquoi tu dis ça"   3. "parce que jme suis perdu dans tes yeux"
     → mot planté : GPS. La chute paie le fait d'être perdu.

Tu vois le moule ? Le viewer entend "voleur", il ne comprend pas, elle demande, et le mot explose en compliment. **C'est une DEVINETTE, pas une déclaration.** Sans mot planté, il n'y a AUCUNE vanne — juste un mec qui dit qu'il la trouve jolie.

⛔⛔ L'ERREUR QUI A TUÉ LES 15 DERNIÈRES VIDÉOS — NE LA REFAIS JAMAIS ⛔⛔
Le modèle a compris "amorce incomplète" comme "ANNONCER qu'on va dire un truc". Résultat, 10 vidéos sur 15 ouvraient par :
  ✗ "j'ai un souci avec toi" / "je crois que j'ai un problème avec toi"
  ✗ "faut que jt'avoue un truc" / "jai un aveu à te faire" / "faut que jte prévienne d'un truc"
  ✗ "attention à toi" / "va falloir que tu te méfies de moi"
Ces phrases sont VIDES : elles ne plantent aucun mot, donc la chute n'a rien à payer. **Ces formulations sont désormais INTERDITES.** Une amorce qui pourrait précéder N'IMPORTE QUELLE chute est une amorce ratée.

⛔ Et la chute ne doit PLUS JAMAIS être "tu me fais perdre mes moyens" sous ses 12 déguisements. Sur les 15 dernières, 8 disaient exactement ça : "jarrive plus à penser à autre chose", "tu vas me faire craquer", "jarrive plus à te sortir de la tête", "me faire perdre le fil", "jm'attache un peu plus", "jcrois que jtombe pour toi". C'est le MÊME message écrit 8 fois. Si ta chute veut dire "tu m'obsèdes", jette-la et repars d'un mot planté.

POURQUOI ça marche, et pourquoi c'est NON NÉGOCIABLE : le viewer lit l'amorce, il se pose la même question qu'elle, il ATTEND la réponse. Quand la chute arrive, il n'a aucun effort à faire — c'est une réponse à une question qu'il vient de lire. Zéro décodage.

✅ LES RÈGLES DURES — non négociables :
0. **VARIE — c'est devenu le défaut n°1.** Les exemples plus haut sont là pour te montrer la MÉCANIQUE et le NIVEAU D'HUMOUR, pas pour être resservis. Mesuré sur les 20 dernières vidéos : "assurance" 3 fois, "clim" 2 fois, **7 amorces sur 20 commençaient par "faudra/faudrait"**, et 6 tournaient autour de la température (couverture, thermostat, clim, thermomètre, fièvre).
   → Change de DOMAINE à chaque fois. Le monde est plein de mots à planter : les métiers (serrurier, plombier, vétérinaire, prof de maths, juge), les objets du quotidien (chargeur, parapluie, écouteurs, cafetière, miroir), les lieux (bibliothèque, pharmacie, station essence, ascenseur), le sport, la bouffe, la musique, la météo, l'école, les transports...
   → Change aussi de FORMULE d'ouverture. Pas toujours "faudra que...". Autres entrées possibles : une question ("t'aurais pas..." / "ton père serait pas..."), une accusation ("t'as pas volé..."), un constat sec ("toi t'as un truc de..."), un ordre ("note ce que jte dis"), une inquiétude feinte ("jsuis mal là").
   → Si le mot que tu allais planter apparaît dans la liste "déjà utilisé" en bas du prompt, tu en prends un autre. Point.
1. **L'AMORCE : 45 caractères max, et elle DOIT contenir un mot concret que la chute va faire exploser** (un métier, un objet, un lieu, un chiffre, un truc du quotidien : voleur, peintre, pompier, gps, assurance, dentiste, wifi, aspirine, clim, permis, ceinture, boulangerie...). Test : est-ce qu'un mot précis est planté ? Si l'amorce ne parle de RIEN de concret, elle est ratée.
2. **LA RELANCE : 4 MOTS MAXIMUM, et elle ne fait AUCUNE vanne.** "non pourquoi ?", "pourquoi", "de quoi", "à quoi", "et donc ?", "quel film ?". Elle est un tremplin, pas une partenaire de banter. Si elle réplique avec de l'esprit ici, la chute tombe à plat.
3. **LA CHUTE : 65 caractères max, UNE SEULE PROPOSITION.** Commence le plus souvent par "parce que" / "bah" — c'est une réponse, elle doit sonner comme une réponse.
4. **LA CHUTE PAIE LE MOT PLANTÉ, avec une image archi-connue.** Voler mon cœur, couper le souffle, les étoiles dans les yeux, une œuvre d'art, faire fondre, se perdre, tomber. **N'ESSAIE PAS D'ÊTRE ORIGINAL SUR L'IMAGE** — l'originalité est dans le MOT PLANTÉ (le chemin), jamais dans l'image finale. Le plaisir vient de la variation sur du connu.
   Test imparable : cache la chute et relis l'amorce. Si tu ne peux pas deviner de quoi ça va parler, c'est bon. Si l'amorce ne plante aucun mot, tu n'as pas de vanne.
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

⚠️ LE STORY REPLY — c'est la 1re seconde de la vidéo, et c'est un DM :

Répondre à une story, C'EST envoyer un DM à une meuf qu'on ne connaît pas vraiment. Écris-le donc comme un PREMIER DM à sa crush : il doit tenir tout seul, sans la story.

⛔ INTERDICTION ABSOLUE — ne parle JAMAIS de la story ni du fait de l'avoir postée.
Sont bannis : les mots "story", "poster/postes/posté/postant", "prise", "photo", "filtre", et toute allusion à pourquoi/quand/comment elle a posté.
Mesure réelle sur les 15 dernières vidéos : 8 commentaient l'acte de poster, dont "toi tu savais très bien ce que tu faisais en postant ça", "tu postes ça pour toi ou pour qu'on te le dise", "sois honnête tu visais qui exactement en postant ça". C'est le même message réécrit 8 fois. Terminé.
⛔ Et surtout n'écris JAMAIS une variante de "tu savais très bien ce que tu faisais" / "tu sais très bien l'effet que ça fait" : c'est LA phrase qui revient le plus.

✅ Vise : une amorce qui l'oblige à demander pourquoi, une accusation inventée assumée au calme, un faux diagnostic sur elle, un ordre tranquille sans explication. Bref, du CULOT sur ELLE — jamais un commentaire sur son contenu.
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

⚠️ LE TITRE (champ "introCaption") — c'est la 1re seconde de la vidéo, c'est lui qui fait s'arrêter le pouce.
Choisis EXACTEMENT une phrase dans cette liste, recopiée au caractère près (aucune invention, aucune variante) :
${(introPool === "drole" ? INTRO_CAPTIONS_DROLES : ACTIVE_INTRO_CAPTIONS_CLASSIQUES).map((c) => `  · ${c}`).join("\n")}
${introPool === "drole" ? `
Ces titres sont volontairement "second degré" / provocateurs — c'est un APPÂT pour faire réagir en commentaire ("attends QUOI ?"). Prends celui qui colle le mieux au scénario que tu vas écrire ; ne le rejette pas parce qu'il te semble limite, c'est fait exprès et déjà validé.

⛔⛔ RÈGLE ABSOLUE : la conversation, elle, est une conv de drague NORMALE et ne fait JAMAIS référence au titre. Si tu choisis "je dm la sœur de mon pote", il est INTERDIT d'écrire "t'es la sœur de mon pote mais..." ou "si ton frère savait" dans les messages. Zéro mention. Le spectateur fait le lien tout seul, c'est ça qui marche — l'expliquer tue la vanne et rend la vidéo bizarre au premier degré.` : `
Prends celui qui colle le mieux à CE scénario. Format DM à froid → un titre qui parle de dm. Réponse à une story → un titre qui parle de gérer / de répondre. Si la conv est chaude, prends un titre qui promet du lourd.`}

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
{"girlName":"...","status":"...","introCaption":"...","storyReply":"...","outroText":"...","beats":[{"kind":"message","from":"girl","text":"..."}, {"kind":"tacotac","tone":"spicy","text":"..."}, {"kind":"meme","asset":"carton-rouge.jpg"}]}`;

// JSON schema (backend API uniquement — sortie structurée garantie).
// Fonction (pas une constante figée) : l'enum introCaption doit refléter le
// pool imposé pour CETTE vidéo (voir IntroPool), sinon le schéma autoriserait
// le modèle à reprendre un titre classique alors qu'un titre drôle est dû.
const buildOutputSchema = (introPool: IntroPool) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    girlName: { type: "string" },
    status: { type: "string" },
    introCaption: { enum: introPool === "drole" ? INTRO_CAPTIONS_DROLES : ACTIVE_INTRO_CAPTIONS_CLASSIQUES },
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
  required: ["girlName", "status", "introCaption", "storyReply", "outroText", "beats"],
} as const);

type GenBeat =
  | { kind: "message"; from: "girl" | "client"; text: string }
  | { kind: "tacotac"; tone: string; text: string }
  | { kind: "meme"; asset: string };
type GenOutput = {
  girlName: string;
  status: string;
  introCaption: string;
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

function callCli(angles: { story: string; outro: string; archetype: string }, structure: Structure, tone: Tone, introPool: IntroPool): GenOutput {
  const prompt = `${systemPromptTacotac}\n\n═══════════\n${buildGenInstruction(angles, structure, tone, introPool)}\n\n${jsonShape}\n\nGénère un nouveau scénario, original et drôle.`;
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
async function callApi(angles: { story: string; outro: string; archetype: string }, structure: Structure, tone: Tone, introPool: IntroPool): Promise<GenOutput> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const params: Record<string, unknown> = {
    model: "claude-opus-4-8",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: `${systemPromptTacotac}\n\n═══════════\n${buildGenInstruction(angles, structure, tone, introPool)}`,
    output_config: { format: { type: "json_schema", schema: buildOutputSchema(introPool) } },
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

function assemble(g: GenOutput, state: State, structure: Structure, forcedTone: Tone, introPool: IntroPool) {
  const girl = nextGirl(state);
  // Titre choisi par le MODÈLE, mais SEULEMENT dans le pool imposé pour cette
  // vidéo (voir IntroPool) — en cohérence avec le scénario qu'il vient d'écrire.
  // S'il invente une phrase hors liste, ou pioche dans l'AUTRE pool (backend CLI
  // = pas de schéma contraignant), on retombe sur la rotation code À L'INTÉRIEUR
  // du même pool imposé : jamais de titre inventé à l'écran, et le pool forcé
  // n'est jamais contourné même en cas de fallback.
  const allowedCaptions = introPool === "drole" ? INTRO_CAPTIONS_DROLES : ACTIVE_INTRO_CAPTIONS_CLASSIQUES;
  const introCaption = allowedCaptions.includes(g.introCaption) ? g.introCaption : nextIntroCaption(state, introPool);
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
  // Meme "il prépare son coup" inséré par le CODE juste avant l'écran DM (voir
  // AVANT_DM_MEMES / nextAvantDmMeme) : ni choisi ni placé par le modèle, pour
  // que ça tourne vraiment entre les 4 memes validés plutôt que de dépendre de
  // ce que le modèle pense à faire.
  if (structure === "B") {
    const dmIndex = beats.findIndex((b) => b.type === "tacotac" && b.tool === "dm");
    const avantDm = nextAvantDmMeme(state);
    if (dmIndex >= 0 && avantDm) {
      const { full, beat } = resolveMemeAsset(avantDm);
      beats.splice(dmIndex, 0, { type: "meme", asset: full, beat });
    }
  }
  return {
    id: `vid_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    girl: { name: g.girlName, avatar: girl, status: g.status, storyThumbnail: girl },
    // Format B : la conv démarre sur le DM d'ouverture, il n'y a aucune story à
    // laquelle répondre — on retire le bandeau "Vous avez répondu à sa story".
    storyReply: structure === "B" ? undefined : clean(g.storyReply) || undefined,
    // Format B : la vidéo ouvre sur SA photo (la même que l'avatar de la conv),
    // puis le meme de réaction, puis l'écran DM de l'app.
    openPhoto: structure === "B" ? girl : undefined,
    // Titre incrusté sur l'intro, choisi par le modèle dans le pool imposé (voir IntroPool).
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

  // ── L'AMORCE DOIT PLANTER UN MOT, pas annoncer qu'on va parler ────────────
  // Sur les 15 dernières vidéos, 10 ouvraient le piège par une phrase VIDE :
  // "j'ai un souci avec toi", "faut que jt'avoue un truc", "va falloir que tu te
  // méfies". Elles ne plantent aucun mot, donc la chute n'a rien à payer et il
  // ne reste qu'un compliment plat. Le prompt l'interdit ; ici c'est mécanique.
  if (lastTacotac > 0) {
    let a = lastTacotac - 1;
    while (a >= 0 && beats[a].type === "meme") a--;
    a--; // on saute la relance pour atteindre l'amorce
    while (a >= 0 && beats[a].type === "meme") a--;
    const amorce = beats[a];
    if (amorce?.type === "message" || amorce?.type === "tacotac") {
      const t = (amorce.text || "").toLowerCase();
      if (/\b(souci|probl[eè]me)\b.{0,12}\b(avec toi|toi)\b|jai un (souci|probl[eè]me)|un (souci|probl[eè]me) avec toi/.test(t)) {
        problems.push(`amorce vide "j'ai un souci/problème avec toi" : "${amorce.text}"`);
      }
      if (/\b(avoue|aveu|pr[ée]venir|pr[ée]viens|dire un truc|te dise un truc|annoncer)\b/.test(t)) {
        problems.push(`amorce vide (annonce au lieu de planter un mot) : "${amorce.text}"`);
      }
      if (/\b(m[ée]fie|m[ée]fier|attention)\b/.test(t) && !/\b(à ton|à ta|à tes)\b/.test(t)) {
        problems.push(`amorce vide (mise en garde sans mot planté) : "${amorce.text}"`);
      }
    }
  }

  // ── Elle ne parle JAMAIS d'un autre mec ───────────────────────────────────
  // Tom : "très souvent la fille disait un mec vient me dire la même chose / t'es
  // pas tout seul à dire ça... on ressent un peu chiant et c'est répétitif".
  // Ça venait d'un archétype qui demandait explicitement "elle mentionne un autre
  // mec / une légère compétition" — remplacé. Verrou pour les rechutes.
  for (const b of beats) {
    if (b.type !== "message" || b.from !== "girl" || !b.text) continue;
    const t = b.text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/(un autre|autre mec|autre gars|t'?es pas le seul|pas le premier|le (deuxieme|troisieme|4eme)|deja un mec|y'?a un mec|un mec qui|la concurrence|comme les autres|tous les mecs|meme chose que)/.test(t)) {
      problems.push(`elle parle d'un autre mec (tic répétitif) : "${b.text}"`);
    }
  }

  // ── Le mot planté ne doit pas resservir ───────────────────────────────────
  // Le prompt le demande, mais le modèle recyclait quand même ("assurance" 3 fois
  // sur 20). On compare le vocabulaire de l'amorce à celui des amorces récentes :
  // un mot "porteur" (>4 lettres, hors mots outils) déjà utilisé = régénération.
  if (lastTacotac > 0) {
    let a = lastTacotac - 1;
    while (a >= 0 && beats[a].type === "meme") a--;
    a--;
    while (a >= 0 && beats[a].type === "meme") a--;
    const amorceText = a >= 0 ? beats[a]?.text || "" : "";
    if (amorceText) {
      // Mots outils : ils reviennent forcément d'une phrase à l'autre et ne sont
      // PAS le mot planté. Les compter ferait rejeter des amorces parfaitement
      // originales juste parce qu'elles disent "va falloir" ou "une bonne".
      const STOP = new Set([
        "faudra", "faudrait", "falloir", "jcrois", "crois", "jespere", "espère", "espere",
        "quelque", "chose", "parce", "avec", "pour", "dans", "toujours", "vraiment",
        "clairement", "serait", "aurais", "prendre", "prends", "vais", "avoir", "bonne",
        "bonnes", "meme", "même", "jamais", "trop", "juste", "peut", "chez", "sans", "plus", "tout", "bien", "cette", "elle", "mais", "quand", "aussi", "encore", "faire", "soir", "nuit", "pere", "père", "frere", "frère", "soeur", "sœur",
      ]);
      const motsDe = (s: string) =>
        (s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z]{4,}/g) || []).filter((m) => !STOP.has(m));
      const dejaVus = new Set(recentOutputs().amorces.flatMap(motsDe));
      const recycle = motsDe(amorceText).find((m) => dejaVus.has(m));
      if (recycle) {
        problems.push(`amorce recycle le mot "${recycle}" déjà utilisé récemment : "${amorceText}"`);
      }
    }
  }

  // ── Elle ne parle pas date/lieu/horaire au début ──────────────────────────
  // Tom : "aucune fille dès le premier message va dire ok mais moi je choisis le
  // lieu et la date, c'est trop bidon". Ça venait d'un archétype qui demandait
  // explicitement de négocier la logistique — corrigé — mais on verrouille aussi,
  // car c'est LE détail qui trahit une conv écrite d'avance.
  {
    let girlSeen = 0;
    for (const b of beats) {
      if (b.type !== "message" || b.from !== "girl") continue;
      girlSeen++;
      if (girlSeen > 3) break;
      const t = (b.text || "").toLowerCase();
      if (/\b(le lieu|l'endroit|l'heure|le jour|qui d[ée]cide|c'est moi qui choisis|je choisis (le|l'|où|quand))\b/.test(t)) {
        problems.push(`elle parle logistique de date trop tôt (message ${girlSeen}) : "${b.text}"`);
      }
    }
  }

  // ── Plus jamais "sérieux ou juste le physique" ────────────────────────────
  // Tom : "il y a trop souvent dans les vidéos un truc du style ok mais toi tu
  // cherche du sérieux ou juste pour mon physique". Racine : l'archétype de conv
  // décrivait cette question mot pour mot entre parenthèses — même maladie que
  // "t'as l'énergie de..." et "snapchat", le modèle recopiait l'exemple au lieu
  // de s'en inspirer. Le pool est corrigé ; ce filtre couvre les scénarios déjà
  // en file et toute résurgence, sur TOUS les messages (pas que l'amorce).
  for (const b of beats) {
    if (b.type !== "message" || !b.text) continue;
    const t = b.text.toLowerCase();
    if (/s[ée]rieux/.test(t) && /(juste|que).{0,20}(physique|le physique)/.test(t)) {
      problems.push(`tic "sérieux ou juste le physique" : "${b.text}"`);
    }
  }

  // ── La chute ne doit plus être "tu m'obsèdes" pour la 9e fois ─────────────
  // 8 des 15 dernières disaient exactement ça, sous 8 déguisements différents.
  if (lastTacotac >= 0) {
    const c = (beats[lastTacotac].text || "").toLowerCase();
    const obsession = [
      /plus (à |a )?(te sortir|penser)/, /sortir de la t[êe]te/, /penser (à|a) autre chose/,
      /perdre (le fil|mes moyens)/, /me faire craquer/, /jm'attache/, /m'attacher un peu plus/,
      /tomber pour toi/, /obs[èe]d/,
    ];
    if (obsession.some((r) => r.test(c))) {
      problems.push(`chute déjà vue 8 fois ("tu m'obsèdes") : "${beats[lastTacotac].text}"`);
    }
  }

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
  if (last?.type === "message" && last.from === "girl") {
    if (last.text.length > MAX_FIN_CHARS) {
      problems.push(`compliment final ${last.text.length} car (max ${MAX_FIN_CHARS}) : "${last.text}"`);
    }
    const f = last.text.toLowerCase();
    // Ils ne se sont JAMAIS parlé avant : elle ne peut pas être nostalgique de lui.
    // Vu en vrai : "bon ok tu m'as manqué en vrai" pour clore un DM à froid.
    if (/manqu[ée]|comme d'hab|[çc]a fait longtemps|te revoir|se revoit|depuis le temps|retrouver/.test(f)) {
      problems.push(`fin : suppose qu'ils se connaissent déjà : "${last.text}"`);
    }
    // Une fin logistique n'est pas un compliment — elle vole la conclusion.
    if (/jdois filer|jte laisse|on en reparle|envoie ton|ton snap|plus tard|à plus/.test(f)) {
      problems.push(`fin logistique au lieu d'un compliment : "${last.text}"`);
    }
  }

  // ── Elle ne double JAMAIS ses messages ────────────────────────────────────
  // Deux bulles grises d'affilée, ça donne l'impression qu'elle se parle à
  // elle-même — c'est le tell n°1 de la fausse conv. Vu 2 fois de suite en fin
  // de vidéo : le modèle écrivait une réplique tiède ("mdrr sympa mais jai
  // vraiment pas le temps la"), puis rajoutait le compliment dans un 2e message.
  // Elle attend toujours qu'il réponde. (Lui peut enchaîner : c'est naturel
  // qu'un mec envoie deux messages de suite, et ça n'a jamais choqué.)
  const msgs = beats.filter((b) => b.type === "message");
  for (let i = 0; i < msgs.length - 1; i++) {
    if (msgs[i].from === "girl" && msgs[i + 1].from === "girl") {
      problems.push(`elle envoie 2 messages d'affilée : "${msgs[i].text}" + "${msgs[i + 1].text}"`);
    }
  }

  // ── Format DM : il écrit forcément en premier ─────────────────────────────
  // 4 vidéos sur 15 s'ouvraient sur un message de la FILLE alors qu'il ne lui a
  // jamais écrit ("n'importe quoi jsuis juste hyper occupée" en 1er message) :
  // elle répondait à rien, la conv était incompréhensible dès la 1re seconde.
  if (script.openPhoto) {
    const first = beats.find((b) => b.type !== "meme");
    if (first?.type === "message" && first.from === "girl") {
      problems.push(`format DM : la fille parle en premier, impossible ("${first.text}")`);
    }
  }

  if (script.storyReply && script.storyReply.length > MAX_STORY_CHARS) {
    problems.push(`storyReply ${script.storyReply.length} car (max ${MAX_STORY_CHARS}) : "${script.storyReply}"`);
  }
  // Le tic n°1 remonté par Tom : le 1er message commente le fait d'avoir posté la
  // story. C'était dans 8 des 15 dernières vidéos, toujours la même phrase. Le
  // prompt l'interdit, mais un interdit se contourne — celui-ci non.
  if (script.storyReply) {
    const sr = script.storyReply.toLowerCase();
    if (/\bstor(y|ies)\b|\bpost(e|es|er|é|ée|ant|ais|ait)\b|\bprise\b|\bfiltre\b/.test(sr)) {
      problems.push(`storyReply parle de la story / du fait de poster : "${script.storyReply}"`);
    }
    if (/tu sav(ais|es).{0,20}(ce que|l'effet|quoi)/.test(sr)) {
      problems.push(`storyReply reprend le tic "tu savais très bien ce que tu faisais" : "${script.storyReply}"`);
    }
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
  const introPool = nextIntroPool(state); // pool de titre imposé, voir IntroPool
  for (let attempt = 1; attempt <= MAX_LENGTH_RETRIES; attempt++) {
    const g = backend === "api" ? await callApi(angles, structure, tone, introPool) : callCli(angles, structure, tone, introPool);
    const candidate = assemble(g, state, structure, tone, introPool);
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
    introCaption: "", // hors liste exprès : teste le fallback nextIntroCaption()
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
  // "fake" n'a pas de champ introCaption : chaque appel exerce donc aussi le
  // fallback nextIntroCaption() (comme le fallback meme, déjà testé plus haut).
  for (const st of STRUCTURES) {
    for (const pool of ["classique", "drole"] as const) {
      scriptSchema.parse(assemble(fake, state, st, tones[0], pool));
    }
  }
  console.log("✅ self-test OK — assemble + validation zod passent (fallback meme + titre inclus)");
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

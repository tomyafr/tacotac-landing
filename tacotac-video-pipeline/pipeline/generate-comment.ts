/**
 * Générateur du 3e format Tacotac — "réponse à un commentaire" (~60-75s).
 *
 * Contrairement aux deux autres formats, le point de départ n'est JAMAIS généré
 * par l'IA : c'est un VRAI commentaire TikTok (capture d'écran + pseudo + texte)
 * ajouté à la main par le collaborateur. Le modèle écrit uniquement la conv qui
 * en découle — il ne choisit ni le commentaire, ni la fille (rotation), ni les
 * tons (rotation), ni les memes exacts au-delà du fichier (catalogue fermé).
 *
 * Usage :
 *   npx tsx pipeline/generate-comment.ts --username="Lucas" \
 *     --text="essaye ça : on est pas jet lag nous..." \
 *     --image="comments/lucas-jetlag.png" [--profile=tom|anomy|solene]
 *   npx tsx pipeline/generate-comment.ts --selftest
 *
 * Backend : Claude Code (`claude -p`) = abonnement, jamais l'API à crédits —
 * même principe et même résolution de binaire que generate.ts / generate-pov.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scriptSchema, toneEnum, type Tone } from "../src/schema";
import { durationSeconds, MAX_DURATION_SECONDS_COMMENT } from "../src/timing";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const PROFILE = (process.env.TACOTAC_PROFILE || "").replace(/[^a-z0-9_-]/gi, "");
const SUFFIX = PROFILE ? `-${PROFILE}` : "";
const QUEUE = path.join(HERE, `queue-comment${SUFFIX}`);
const STATE_PATH = path.join(HERE, `state-comment${SUFFIX}.json`);

const systemPromptTacotac = fs.readFileSync(path.join(REPO, "system_prompt_tacotac.md"), "utf8");
const library = JSON.parse(
  fs.readFileSync(path.join(ROOT, "public", "memes", "library.json"), "utf8")
) as { beats: Record<string, { desc: string; memes: string[] }> };
const beatTags = Object.keys(library.beats);

// Mêmes 4 tons que le format principal — les seuls avec un vrai screenshot de
// l'app (voir TacotacScreenshot.tsx SHOT_TONES). "drole"/"mystere" n'en ont pas
// et tombent sur un rendu natif incohérent (bug trouvé et corrigé le 16/09).
const ALLOWED_TONES: readonly Tone[] = ["classe", "spicy", "sexto", "romantique"];
const TONE_BRIEFS: Record<string, string> = {
  classe: "élégant et sûr de lui. La chute est un compliment bien tourné, jamais lourd.",
  spicy: "taquin et joueur, il la chambre. La chute pique un peu, sous-entendue, jamais vulgaire.",
  sexto: "chaud mais SUGGÉRÉ, jamais explicite. La chute joue sur le trouble, l'allusion, jamais le mot cru.",
  romantique: "sincère et désarmant. La chute est un aveu franc, un peu vulnérable.",
};
const tones = toneEnum.options.filter((t): t is Tone => ALLOWED_TONES.includes(t));

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
  console.error(`✗ Aucune photo dans public/${AVATAR_DIR}/ — ajoute des fichiers .jpg/.png avant de générer.`);
  process.exit(1);
}

const memeCatalog: { basename: string; full: string; beat: string }[] = [];
for (const [beat, { memes }] of Object.entries(library.beats)) {
  if (beat === "avant_dm") continue; // spécifique à l'autre format, pas de sens ici
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

// Titres courts pour CE format — le modèle s'en inspire fortement (même
// consigne "presque identique" que generate.ts) plutôt que de piocher au hasard
// dans un registre trop large, qui donnait des titres qui se répétaient ou
// partaient n'importe où (voir generate.ts pour l'historique de cette leçon).
const TITLE_EXAMPLES = [
  "je dm avec un commentaire",
  "je teste un commentaire en dm",
  "un commentaire m'a donné une idée",
  "je réponds à un commentaire par dm",
  "j'ai testé votre commentaire",
];

const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const stripEmoji = (s: string) =>
  s.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
const clean = (s: string) => stripEmoji(s.replace(/\s*\.\s*$/u, ""));

// ── Rotation (même mécanique que generate.ts : jamais de doublon avant d'avoir
// épuisé tout le pool) — fichier de state SÉPARÉ du format principal : les deux
// formats ne doivent jamais se marcher dessus ni partager leur rotation. ──────
type State = {
  girlOrder: string[]; girlIndex: number;
  toneOrder: Tone[]; toneIndex: number;
  titleOrder: string[]; titleIndex: number;
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
    toneOrder: shuffle([...tones]), toneIndex: 0,
    titleOrder: shuffle(TITLE_EXAMPLES), titleIndex: 0,
  });
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
    const sameSet = (stored: unknown, pool: readonly string[]) =>
      Array.isArray(stored) && stored.length === pool.length && stored.every((v) => pool.includes(v as string));
    const ok = sameSet(s.girlOrder, girlFiles) && sameSet(s.toneOrder, tones) && sameSet(s.titleOrder, TITLE_EXAMPLES);
    return ok ? s : fresh();
  } catch {
    return fresh();
  }
}
const saveState = (s: State) => fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

function nextGirl(state: State): string {
  if (state.girlIndex >= state.girlOrder.length) { state.girlOrder = shuffle(girlFiles); state.girlIndex = 0; }
  const g = state.girlOrder[state.girlIndex]; state.girlIndex++; saveState(state); return g;
}
// Renvoie 2 tons DISTINCTS pour cette vidéo (2 passages Tacotac, jamais le même
// ton deux fois dans la même vidéo) — rotation sur le pool des 4 tons.
function nextTonePair(state: State): [Tone, Tone] {
  const pick = (): Tone => {
    if (state.toneIndex >= state.toneOrder.length) { state.toneOrder = shuffle([...tones]); state.toneIndex = 0; }
    const t = state.toneOrder[state.toneIndex]; state.toneIndex++; return t;
  };
  const a = pick();
  let b = pick();
  if (b === a) b = pick(); // évite un doublon dans la même vidéo, sans casser la rotation globale
  saveState(state);
  return [a, b];
}
function nextTitle(state: State): string {
  if (state.titleIndex >= state.titleOrder.length) { state.titleOrder = shuffle(TITLE_EXAMPLES); state.titleIndex = 0; }
  const t = state.titleOrder[state.titleIndex]; state.titleIndex++; saveState(state); return t;
}

// ── Prompt ───────────────────────────────────────────────────────────────
type CommentInput = { username: string; text: string; image: string };

function buildGenInstruction(comment: CommentInput, tonePair: [Tone, Tone], titleExample: string): string {
  const her = REVERSED ? "le mec" : "la fille";
  const him = REVERSED ? "la cliente" : "le client";
  return `Tu génères la SUITE d'une vidéo TikTok qui fait la promo de Tacotac (l'app qui souffle les disquettes). Cette vidéo est différente des autres : elle démarre sur un VRAI commentaire laissé par un spectateur, que ${him} utilise comme ligne d'ouverture.

⚠️ LE COMMENTAIRE (déjà affiché à l'écran avant ta conv, tu ne l'inventes pas) — pseudo "${comment.username}" :
"${comment.text}"

Ce commentaire EST le tout premier message envoyé à ${her} (en réponse à sa story) — il est déjà fixé, tu n'as rien à écrire pour cette ligne. Ton travail commence à SA réaction à elle.

⛔⛔ RÈGLE ABSOLUE — NE PARS JAMAIS EN VRILLE SUR LE COMMENTAIRE : le commentaire peut être absurde, une référence à un mème, un délire interne — tu n'as PAS à comprendre la référence exacte ni à l'expliquer. Traite-le juste comme une ligne d'approche culottée. ${her} réagit UNE FOIS (amusée, surprise, ou qui relève que c'est bizarre) — et ENSUITE la conv devient une conv de drague NORMALE, comme toutes les autres vidéos Tacotac. INTERDIT de revenir sur le commentaire après le 2e ou 3e message, INTERDIT d'inventer un sens caché au commentaire, INTERDIT de laisser le commentaire diriger toute la conversation. Si tu ne sais pas quoi en faire après la première réaction, oublie-le et enchaîne sur un sujet de drague classique.

FORMAT : ${him} drague ${her} en DM Instagram, réponse à sa story. Pas d'app de rencontre, pas de mot "match".

⛔ LA STORY DE ${her.toUpperCase()} EST TOUJOURS ET UNIQUEMENT UNE PHOTO D'ELLE, SANS LÉGENDE NI SUJET — jamais un texte, une annonce, un article, une opinion, quoi que ce soit à "raconter". INTERDIT d'écrire une ligne qui présuppose que la story avait un contenu/sujet/message à décrire (ex: "elle parlait de quoi ta story", "c'était sur quoi ton post") — ça n'a aucun sens, une story c'est juste une photo qu'on regarde. Si tu veux enchaîner sur la story après la réaction au commentaire, commente la PHOTO elle-même (un détail visuel que tu inventes librement, un lieu, une ambiance), jamais un "sujet" qu'elle aurait abordé.

⚠️⚠️ DURÉE VISÉE — LIS ATTENTIVEMENT, C'EST CE QUI PART LE PLUS SOUVENT EN VRILLE : cette vidéo vise 60 à 75 secondes, DEUX FOIS PLUS LONGUE que les vidéos Tacotac habituelles. MAIS cette durée vient du RYTHME (les memes et les 2 passages Tacotac), PAS d'un nombre illimité d'échanges de conversation NI de messages longs. Une conv à rallonge avec 15-20 messages, ou des messages longs comme de vraies phrases, produit une vidéo BEAUCOUP TROP LONGUE (déjà vu : 79s, 81s, 83s, 90s, 120s) — c'est un ÉCHEC aussi grave qu'une vidéo trop courte.
⚠️ CIBLE CHIFFRÉE OBLIGATOIRE : 20 à 25 beats au total (messages + tacotac + memes confondus), JAMAIS plus de 27. Avec 7-9 memes et 2 passages Tacotac (qui comptent chacun pour 1 beat tacotac + 1 beat message dupliqué), il ne reste qu'environ 8 à 11 messages de pure conversation pour tenir dans ce total — répartis-les sur 2 sujets courts, pas plus. Compte tes beats avant de répondre : si tu dépasses 25, coupe des messages de conv, JAMAIS des memes.
⚠️ CHAQUE MESSAGE DE CONV (hors tacotac) : UNE SEULE LIGNE COURTE, 3 à 8 mots, comme un vrai DM tapé vite — jamais une phrase complète ou deux idées dans le même message. C'est la longueur du TEXTE qui fait déraper la durée bien plus que le nombre de beats : un message de 15 mots dure 2 à 3 fois plus longtemps à l'écran qu'un message de 5 mots.

⚠️ TACOTAC UTILISÉ 2 FOIS — DEUX MÉCANIQUES COMPLÈTES EN 3 TEMPS (amorce → relance → chute), séparées par au moins 2-3 messages normaux de conv entre les deux (jamais collées) :
  • 1er passage : ton "${tonePair[0]}" — ${TONE_BRIEFS[tonePair[0]]}
  • 2e passage : ton "${tonePair[1]}" — ${TONE_BRIEFS[tonePair[1]]}
Rappel de la mécanique (obligatoire à chaque passage) :
  1. L'AMORCE — ${him} lâche une affirmation courte qui ne veut RIEN dire toute seule (un mot planté : un métier, un objet, une situation). C'est un beat {"kind":"message","from":"client"} NORMAL, PAS un beat tacotac.
  2. LA RELANCE — ${her} est OBLIGÉE de demander ("pourquoi", "de quoi", 1 à 4 mots, jamais de vanne). Beat {"kind":"message","from":"girl"} normal aussi.
  3. LA CHUTE — ${him} referme, le mot planté explose en compliment/vanne. C'est LÀ que ça paie, nulle part ailleurs. C'EST LE SEUL DES 3 QUI EST UN BEAT {"kind":"tacotac"} — c'est la ligne que l'app a soufflée.
⛔⛔ EXACTEMENT 2 BEATS "tacotac" DANS TOUTE LA VIDÉO, PAS UN DE PLUS : uniquement les 2 CHUTES (une par passage). L'amorce et la relance ne sont JAMAIS des beats "tacotac", même si elles font partie de la mécanique — les taguer "tacotac" fait apparaître l'écran de l'app 2 fois par passage au lieu d'1, ça casse tout le format (déjà vu : 4 beats tacotac dans une vidéo au lieu de 2).
⛔ Chaque beat "tacotac" (la chute, donc) est IMMÉDIATEMENT suivi d'un beat "message" du client avec EXACTEMENT le même texte (le message envoyé).
⛔⛔ L'AMORCE INTERDITE (erreur classique) : "faut que je t'avoue un truc" / "j'ai un aveu à te faire" / "j'ai un souci avec toi" / "va falloir que tu te méfies" — ces phrases n'ANNONCENT rien de concret, elles ne plantent AUCUN mot, donc la chute n'a rien à payer. Une bonne amorce plante un mot précis (un métier, un objet, une situation) que la chute va détourner — jamais une simple annonce qu'on va parler.
⛔⛔ LA CHUTE DOIT ENVOYER FORT, JAMAIS UN COMPLIMENT PLAT (Tom, 17/09, sur "les gens qui écrivent bien, tu viens d'y entrer" : "faut pas dire des compliments de merde comme ça... faut balancer des disquettes de fou pas des trucs nuls"). Un compliment générique accroché à un détail anodin de la conv (elle a mentionné un truc en passant → "les gens qui X, tu viens d'y entrer") sonne creux et hors sujet, surtout tôt dans l'échange. La chute doit draguer vraiment : une image forte, un jeu de mots qui claque, un compliment qui SURPREND — le genre de ligne qu'on a envie de screenshot. Pense à des mécaniques éprouvées (elle rejoint une "collection" d'œuvres d'art, elle devient une exception à une règle qu'il pose, etc.), jamais une simple observation polie sur un détail de la conv.

⚠️⚠️ MEMES — C'EST CE QUI PORTE CETTE VIDÉO, PAS LA CONV TOUTE SEULE : au moins 7 dans la vidéo (vise 8-9), quasiment UN MEME TOUS LES 2 MESSAGES quand c'est pertinent. N'HÉSITE JAMAIS à en mettre un — une conv longue sans coupure devient plate et ennuyeuse, même si le texte est bon. Ne laisse JAMAIS s'enchaîner plus de 2 messages d'affilée sans un meme entre les deux. Dans le doute, mets-en un de plus plutôt qu'un de moins : mieux vaut un meme un peu redondant qu'un bloc de texte trop long. Choisis le fichier qui colle le mieux à l'instant précis, jamais deux fois le même dans la vidéo.

⚠️ LA FIN — VARIE, ne mets PAS systématiquement un rendez-vous à une heure précise. Choisis parmi ces registres (change d'une vidéo à l'autre) :
  • un compliment final qui referme sur une bonne note, sans rien programmer.
  • un date évoqué SANS heure précise ("on se voit cette semaine" plutôt que "20h ça marche").
  • un snap échangé — encadre EXACTEMENT le pseudo avec [[SNAP:...]], invente-le toujours fictif (jamais un vrai compte) : "tiens [[SNAP:jul.xk22]] ajoute moi".
  • un numéro suggéré sans être écrit en clair ("je te le donne si tu me fais rire encore une fois").

⚠️ LE TITRE (champ "introCaption") : inspire-toi FORTEMENT de cet exemple, reste presque identique (1-2 mots de marge max, aucun mot inventé hors de l'exemple) : "${titleExample}"

CATALOGUE DE MEMES (choisis le fichier exact le plus pertinent) :
${beatTags.map((t) => `- ${t} (${library.beats[t].desc}) : ${library.beats[t].memes.map((m) => m.replace(/^memes\//, "")).join(", ")}`).join("\n")}

VOIX : minuscules, JAMAIS de point final, phonétique naturelle (jsuis, jte, jsp, tkt, mdr), messages courts (une ligne, comme un vrai DM). ZÉRO EMOJI nulle part (le serveur de rendu n'a pas de police emoji, ça sort en carré vide). Les disquettes suivent STRICTEMENT le system prompt Tacotac ci-dessus.

⚠️ RÈGLES DE QUALITÉ :
- Donne à ${her} un vrai trait de caractère pour CETTE conv, tenu du début à la fin — jamais générique.
- Chaque message de ${her} réagit PRÉCISÉMENT à ce que ${him} vient de dire.
- INTERDIT les messages creux ("mdrr"/"ok" seuls) sauf la relance elle-même, qui EST volontairement courte.
- Fin clairement positive.

⛔⛔ LE CHAMP "from" DES MESSAGES EST UN LABEL TECHNIQUE FIXE, PAS UNE DESCRIPTION : écris TOUJOURS exactement "girl" pour ${her} et "client" pour ${him} — jamais "boy", "il", "elle", ou toute autre valeur, MÊME si ${her} est en réalité un mec. Ce sont les deux SEULES valeurs valides, peu importe qui est réellement dragué dans cette vidéo.`;
}

const jsonShape = `Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour ni bloc de code, de cette forme exacte :
{"girlName":"...","status":"...","introCaption":"...","outroText":"...","beats":[{"kind":"message","from":"girl","text":"..."}, {"kind":"tacotac","tone":"spicy","text":"..."}, {"kind":"meme","asset":"carton-rouge.jpg"}]}`;

type GenBeat =
  | { kind: "message"; from: "girl" | "client"; text: string }
  | { kind: "tacotac"; tone: string; text: string }
  | { kind: "meme"; asset: string };
type GenOutput = { girlName: string; status: string; introCaption: string; outroText: string; beats: GenBeat[] };

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Pas de JSON dans la sortie");
  return raw.slice(start, end + 1);
}

function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === "win32") return "claude.cmd";
  const home = process.env.HOME ?? "/root";
  for (const c of ["/usr/local/bin/claude", "/usr/bin/claude", `${home}/.npm-global/bin/claude`, `${home}/.local/bin/claude`]) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* absent */ }
  }
  return "claude";
}

function callCli(comment: CommentInput, tonePair: [Tone, Tone], titleExample: string): GenOutput {
  const prompt = `${systemPromptTacotac}\n\n═══════════\n${buildGenInstruction(comment, tonePair, titleExample)}\n\n${jsonShape}\n\nGénère la conv, originale et drôle.`;
  const stdout = execFileSync(resolveClaudeBin(), ["-p", "--output-format", "json"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  let resultText = stdout;
  try {
    const env = JSON.parse(stdout);
    if (env.is_error) throw new Error(`Claude Code: ${env.result} (fais 'claude login')`);
    resultText = env.result ?? stdout;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Claude Code:")) throw e;
  }
  return JSON.parse(extractJson(resultText)) as GenOutput;
}

function resolveMemeAsset(asset: string): { full: string; beat: string } {
  const hit = memeByBasename.get(asset) ?? memeByBasename.get(path.basename(asset));
  if (hit) return { full: hit.full, beat: hit.beat };
  console.warn(`⚠️ meme inconnu "${asset}" — fallback aléatoire`);
  return rand(memeCatalog);
}

function assemble(g: GenOutput, state: State, comment: CommentInput, tonePair: [Tone, Tone], titleExample: string) {
  const girl = nextGirl(state);
  const caption = clean(g.introCaption);
  const introCaption = caption && caption.length <= 70 ? caption : titleExample;
  let seenTacotac = 0;
  const beats = g.beats.map((b) => {
    if (b.kind === "message") return { type: "message", from: b.from, text: clean(b.text) };
    if (b.kind === "tacotac") {
      // Le ton n'est PAS laissé au modèle : deux passages forcés, dans l'ordre
      // tiré par le code (voir nextTonePair) — même règle que le format
      // principal, ça évitait une convergence sur un seul ton (ex: "romantique"
      // systématique quand c'était laissé libre).
      const tone = tonePair[Math.min(seenTacotac, tonePair.length - 1)];
      seenTacotac++;
      return { type: "tacotac", tone, text: clean(b.text), tool: "reply" as const };
    }
    const { full, beat } = resolveMemeAsset(b.asset);
    return { type: "meme", asset: full, beat };
  });
  return {
    id: `com_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    comment,
    introCaption,
    girl: { name: g.girlName, avatar: girl, status: g.status, storyThumbnail: girl },
    openPhoto: girl,
    storyReply: comment.text, // le commentaire réel, envoyé tel quel — jamais réécrit par le modèle
    outro: { text: clean(g.outroText), background: rand(OUTRO_BGS) },
    beats,
  };
}

const MIN_DURATION_SECONDS = 55; // en dessous, la vidéo ne mérite pas d'être un format "long"
const MIN_MEMES = 7; // Tom, 16/09 : "pas assez de meme... la conv on s'en fiche un peu"
// Vu en test réel : sans plafond, le modèle écrit une conv à rallonge (15-20
// messages) qui produit une vidéo de 90-120s au lieu de 60-75s visées — la durée
// doit venir des memes/tacotac (rythme), pas d'un nombre illimité d'échanges.
// Plafond resserré le 17/09 (30→27) : même à 30 beats, 3 générations réelles de
// suite sont sorties à 79-83s (juste hors cible) — les messages de conv étaient
// trop longs individuellement, pas seulement trop nombreux.
const MAX_BEATS = 27;
const MAX_LENGTH_RETRIES = 5;
type Candidate = ReturnType<typeof assemble>;

function validationProblems(script: Candidate): string[] {
  const problems: string[] = [];
  const beats = script.beats;
  if (beats.length > MAX_BEATS) problems.push(`${beats.length} beats au total (max ${MAX_BEATS}) — conv trop longue, ça va faire une vidéo hors durée`);
  const memeCount = beats.filter((b) => b.type === "meme").length;
  if (memeCount < MIN_MEMES) problems.push(`seulement ${memeCount} meme(s), il en faut au moins ${MIN_MEMES}`);
  const tacotacCount = beats.filter((b) => b.type === "tacotac").length;
  // EXACTEMENT 2, pas juste "au moins 2" : vu en test réel (17/09) un script avec 4
  // beats tacotac — le modèle avait tagué l'amorce ET la chute des 2 passages en
  // "tacotac" au lieu de la chute seule, doublant les écrans d'app affichés.
  if (tacotacCount !== 2) problems.push(`${tacotacCount} passage(s) Tacotac au lieu de 2 pile (seule la CHUTE de chaque passage est un beat tacotac, jamais l'amorce)`);
  const first = beats.find((b) => b.type !== "meme");
  if (first?.type !== "message" || first.from !== "girl") {
    problems.push(`le 1er beat doit être la réaction de la fille au commentaire, pas autre chose`);
  }
  // Tom, 16/09 : "pas assez de meme... la conv on s'en fiche un peu" — vérifié
  // par le code, pas juste demandé : un "tacotac" compte comme une coupure (déjà
  // un cutaway visuel), mais 3 messages "conv" d'affilée sans rien entre = trop.
  let consecutiveMessages = 0;
  for (const b of beats) {
    if (b.type === "message") {
      consecutiveMessages++;
      if (consecutiveMessages > 2) {
        problems.push(`3 messages de conv d'affilée sans meme/tacotac entre les deux — pas assez rythmé`);
        break;
      }
    } else {
      consecutiveMessages = 0;
    }
  }
  // ── L'AMORCE DOIT PLANTER UN MOT, pas annoncer qu'on va parler ────────────
  // Même règle apprise sur le format principal (generate.ts) : "faut que je
  // t'avoue un truc" / "j'ai un souci avec toi" ne plantent aucun mot, donc la
  // chute n'a rien à payer. Vue en test réel sur CE format aussi (16/09) — la
  // même leçon s'applique aux 2 passages Tacotac, pas juste au dernier.
  for (let i = 0; i < beats.length; i++) {
    if (beats[i].type !== "tacotac") continue;
    let a = i - 1;
    while (a >= 0 && beats[a].type === "meme") a--;
    a--; // on saute la relance pour atteindre l'amorce
    while (a >= 0 && beats[a].type === "meme") a--;
    const amorce = beats[a];
    if (amorce?.type !== "message") continue;
    const t = amorce.text.toLowerCase();
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
  return problems;
}

async function generateOne(state: State, comment: CommentInput) {
  let script: Candidate | null = null;
  let fallback: Candidate | null = null;
  // Tirés UNE SEULE FOIS pour cette vidéo : une régénération corrige un texte
  // non conforme, elle ne doit pas tirer 2 nouveaux tons ou un autre titre.
  const tonePair = nextTonePair(state);
  const titleExample = nextTitle(state);
  for (let attempt = 1; attempt <= MAX_LENGTH_RETRIES; attempt++) {
    // Une sortie mal formée (ex: "from":"boy" au lieu de "girl", vu en test réel)
    // faisait planter TOUTE la génération au lieu de simplement rater CET essai —
    // un essai invalide doit consommer un cran de retry, pas avorter la fonction.
    let candidate: Candidate;
    try {
      const g = callCli(comment, tonePair, titleExample);
      candidate = assemble(g, state, comment, tonePair, titleExample);
      scriptSchema.parse(candidate);
    } catch (e) {
      console.warn(`   ⚠️ sortie invalide — régénération (${attempt}/${MAX_LENGTH_RETRIES})`);
      console.warn(`      ${(e as Error).message.slice(0, 300)}`);
      continue;
    }
    const secs = durationSeconds(candidate);
    const problems = validationProblems(candidate);
    const durationOk = secs >= MIN_DURATION_SECONDS && secs <= MAX_DURATION_SECONDS_COMMENT;
    if (durationOk && problems.length === 0) {
      script = candidate;
      console.log(`   durée ${secs.toFixed(1)}s ✅  ${memeCountLabel(candidate)}`);
      break;
    }
    if (durationOk && !fallback) fallback = candidate;
    if (!durationOk) {
      console.warn(`   ⚠️ durée ${secs.toFixed(1)}s hors cible [${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS_COMMENT}]s — régénération (${attempt}/${MAX_LENGTH_RETRIES})`);
    } else {
      console.warn(`   ⚠️ script non conforme — régénération (${attempt}/${MAX_LENGTH_RETRIES})`);
      for (const p of problems) console.warn(`      ${p}`);
    }
  }
  if (!script && fallback) {
    console.warn(`   ⚠️ aucun scénario parfait après ${MAX_LENGTH_RETRIES} essais — on garde le moins mauvais`);
    script = fallback;
  }
  if (!script) throw new Error(`Impossible d'obtenir un scénario valide après ${MAX_LENGTH_RETRIES} essais`);
  fs.mkdirSync(QUEUE, { recursive: true });
  const outPath = path.join(QUEUE, `${script.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ script }, null, 2));
  return outPath;
}
function memeCountLabel(c: Candidate) {
  return `${c.beats.filter((b) => b.type === "meme").length} memes, ${c.beats.filter((b) => b.type === "tacotac").length} passages tacotac`;
}

function selfTest() {
  const state = loadState();
  const comment: CommentInput = { username: "Test", text: "essaye ça : commentaire de test", image: "comments/lucas-jetlag.png" };
  const fake: GenOutput = {
    girlName: "Léa",
    status: "en ligne il y a 1h",
    introCaption: "",
    outroText: "l'ia gratuite est dans ma bio les coquins",
    beats: [
      { kind: "message", from: "girl", text: "mdrrr t'es sérieux là" },
      { kind: "meme", asset: memeBasenames[0] },
      { kind: "tacotac", tone: "classe", text: "amorce 1" },
      { kind: "message", from: "client", text: "amorce 1" },
      { kind: "message", from: "girl", text: "pourquoi" },
      { kind: "tacotac", tone: "spicy", text: "chute 1" },
      { kind: "message", from: "client", text: "chute 1" },
      { kind: "message", from: "girl", text: "ok toi" },
      { kind: "meme", asset: memeBasenames[1] },
      { kind: "meme", asset: memeBasenames[2] },
      { kind: "meme", asset: "fichier-qui-nexiste-pas.jpg" },
      { kind: "meme", asset: memeBasenames[3] },
      { kind: "meme", asset: memeBasenames[4] },
      { kind: "meme", asset: memeBasenames[5] },
    ],
  };
  const tonePair: [Tone, Tone] = ["classe", "spicy"];
  const s = assemble(fake, state, comment, tonePair, TITLE_EXAMPLES[0]);
  scriptSchema.parse(s);
  const problems = validationProblems(s);
  if (problems.length) throw new Error("self-test a trouvé des problèmes : " + problems.join(" / "));
  console.log(`✅ self-test OK — ${memeCountLabel(s)}, durée ${durationSeconds(s).toFixed(1)}s`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const p = args.find((a) => a.startsWith(`--${name}=`));
    return p ? p.slice(name.length + 3) : undefined;
  };
  return { username: get("username"), text: get("text"), image: get("image"), selftest: args.includes("--selftest") };
}

async function main() {
  const { username, text, image, selftest } = parseArgs();
  if (selftest) return selfTest();
  if (!username || !text || !image) {
    console.error("Usage: npx tsx pipeline/generate-comment.ts --username=... --text=... --image=comments/xxx.png");
    process.exit(1);
  }
  const state = loadState();
  try {
    const p = await generateOne(state, { username, text, image });
    console.log(`✅ → ${path.basename(p)}`);
  } catch (e) {
    console.error(`❌ échec :`, (e as Error).message);
    process.exit(1);
  }
}

main();

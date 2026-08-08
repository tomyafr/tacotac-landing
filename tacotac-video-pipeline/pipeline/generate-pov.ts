/**
 * Générateur du 2e format de vidéo Tacotac — "POV meme".
 *
 * Aucune conversation : un texte "pov : ..." fixe + 3 hashtags, par-dessus un
 * enchaînement de memes réaction (1s chacun, fondu au noir entre chaque).
 *
 * Le MODÈLE n'écrit que le texte et les hashtags. Les memes sont choisis par le
 * CODE, en rotation anti-répétition — comme les filles dans generate.ts : jamais
 * deux fois le même avant d'avoir épuisé le pool, et jamais de doublon À
 * L'INTÉRIEUR d'une même vidéo.
 *
 * Backend : Claude Code (`claude -p`) = abonnement, pas de clé API (identique à
 * generate.ts, même résolution de binaire cron-safe).
 *
 * Usage : npx tsx pipeline/generate-pov.ts [nombre] [--selftest]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { povScriptSchema } from "../src/schema";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");

// Profil = compte destinataire. "solene" => audience FILLES (ta pote drague des
// mecs), défaut/"tom" => audience MECS (ton pote drague des filles).
const PROFILE = (process.env.TACOTAC_PROFILE || "").replace(/[^a-z0-9_-]/gi, "");
const SUFFIX = PROFILE ? `-${PROFILE}` : "";
const QUEUE = path.join(HERE, `queue-pov${SUFFIX}`);
const STATE_PATH = path.join(HERE, `state-pov${SUFFIX}.json`);
const FOR_GIRLS = PROFILE === "solene";

const systemPromptTacotac = fs.readFileSync(path.join(REPO, "system_prompt_tacotac.md"), "utf8");
const library = JSON.parse(
  fs.readFileSync(path.join(ROOT, "public", "memes", "library.json"), "utf8")
) as { beats: Record<string, { desc: string; memes: string[] }> };

// Nombre de memes = durée de la vidéo (1s chacun). La musique fait 14,2s : 14
// memes = 14s, soit pile la piste sans boucle audible.
const MEMES_PER_VIDEO = 14;

// Catégories qui donnent de vraies TÊTES DE RÉACTION (le format repose entièrement
// dessus). On exclut "romantique" (roses/bagues : hors sujet ici) et "victoire"
// (célébrations foot/NBA : illisibles en 1s sans contexte de conv).
const REACTION_BEATS = [
  "il_reflechit",
  "doute",
  "choc",
  "elle_rembarre",
  "il_kiffe",
  "il_prepare_un_move",
  "espoir",
  "retient_rire",
  "bien_joue",
  "confiance",
  "emu",
  "feu_vert",
];
// Memes qui portent déjà un texte incrusté. Parfaits en plein écran dans le format
// "conversation" (ils y passent seuls), mais ici le texte pov est posé par-dessus :
// les deux se chevauchent et plus rien n'est lisible pendant la seconde concernée.
const CAPTIONED_MEMES = new Set([
  "memes/fr-oh-interessant.jpg",
  "memes/fr-degoute-grimace.jpg",
  "memes/fr-cest-ciao.jpg",
  "memes/fr-jai-pas-compris.jpg",
  "memes/les-affaires-sont-les-affaires.jpg",
  "memes/note-0-sur-20.jpg",
  "memes/note-0-sur-10.jpg",
  "memes/zgeg-95.jpg",
  "memes/cest-vrai-ca-capuche.jpg",
]);

const memePool: string[] = [];
for (const beat of REACTION_BEATS) {
  for (const m of library.beats[beat]?.memes ?? []) {
    if (!CAPTIONED_MEMES.has(m)) memePool.push(m);
  }
}
if (memePool.length < MEMES_PER_VIDEO) {
  console.error(`✗ Pool de memes trop petit (${memePool.length} < ${MEMES_PER_VIDEO}).`);
  process.exit(1);
}

// ── Angles POV imposés ──────────────────────────────────────────────────────
// Même remède que dans generate.ts : sans angle imposé, le modèle recopie le
// même scénario à chaque génération. Chaque angle décrit une SITUATION, jamais
// une phrase à recopier — le modèle écrit sa propre formulation.
const POV_ANGLES_GIRLS = [
  "ta pote te demande des conseils pour gérer un mec alors qu'elle a juste à s'inscrire sur tacotac",
  "tu vois ta pote parler à son crush et faire la manip capture d'écran + tacotac, et la conv se finit par un 'à ce soir'",
  "ta pote utilise tacotac et depuis elle gère tous les beaux gosses de sa ville",
  "ta pote t'a caché pendant des mois qu'elle utilisait tacotac et te faisait croire que c'était naturel",
  "tu comprends enfin pourquoi ta pote se prend jamais de vent alors que toi si",
  "ta pote te dit 'jsuis juste moi-même' alors que tu l'as vue coller son screen dans tacotac",
  "ta pote galérait à répondre à son crush, elle passe sur tacotac et le mec devient accro",
  "ta pote refuse de te donner son secret alors que ça fait 3 mois qu'elle enchaîne les dates",
  "tu demandes à ta pote comment elle a eu ce mec, elle change de sujet direct",
  "ta pote t'a enfin avoué son astuce et depuis c'est toi qui gères",
];
const POV_ANGLES_BOYS = [
  "ton pote te demande des conseils pour gérer une fille alors qu'il a juste à s'inscrire sur tacotac",
  "tu vois ton pote parler à son crush et faire la manip capture d'écran + tacotac, et la conv se finit par un 'à ce soir'",
  "ton pote utilise tacotac et depuis il gère tous les 10/10 de sa ville",
  "ton pote t'a caché pendant des mois qu'il utilisait tacotac et te faisait croire que c'était naturel",
  "tu comprends enfin pourquoi ton pote se prend jamais de vent alors que toi si",
  "ton pote te dit 'jsuis juste moi-même' alors que tu l'as vu coller son screen dans tacotac",
  "ton pote galérait à répondre à son crush, il passe sur tacotac et la fille devient accro",
  "ton pote refuse de te donner son secret alors que ça fait 3 mois qu'il enchaîne les dates",
  "tu demandes à ton pote comment il a eu cette fille, il change de sujet direct",
  "ton pote t'a enfin avoué son astuce et depuis c'est toi qui gères",
];
const POV_ANGLES = FOR_GIRLS ? POV_ANGLES_GIRLS : POV_ANGLES_BOYS;

// ── Rotation anti-répétition (même mécanique que generate.ts) ───────────────
type State = { angleOrder: string[]; angleIndex: number; memeOrder: string[]; memeIndex: number };

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
    angleOrder: shuffle(POV_ANGLES), angleIndex: 0,
    memeOrder: shuffle(memePool), memeIndex: 0,
  });
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as State;
    const ok =
      Array.isArray(s.angleOrder) && s.angleOrder.length === POV_ANGLES.length &&
      Array.isArray(s.memeOrder) && s.memeOrder.length === memePool.length;
    return ok ? s : fresh();
  } catch {
    return fresh();
  }
}
const saveState = (s: State) => fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

function nextAngle(state: State): string {
  if (state.angleIndex >= state.angleOrder.length) {
    state.angleOrder = shuffle(POV_ANGLES);
    state.angleIndex = 0;
  }
  const angle = state.angleOrder[state.angleIndex];
  state.angleIndex++;
  saveState(state);
  return angle;
}

// Tire MEMES_PER_VIDEO memes distincts. La rotation garantit qu'on ne revoit pas
// un meme avant d'avoir parcouru tout le pool ; le Set protège du seul cas où le
// pool se recycle en plein milieu d'une vidéo (sinon on aurait un doublon visible
// à quelques secondes d'intervalle).
function nextMemes(state: State): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (picked.length < MEMES_PER_VIDEO && guard < memePool.length * 3) {
    guard++;
    if (state.memeIndex >= state.memeOrder.length) {
      state.memeOrder = shuffle(memePool);
      state.memeIndex = 0;
    }
    const m = state.memeOrder[state.memeIndex];
    state.memeIndex++;
    if (seen.has(m)) continue;
    seen.add(m);
    picked.push(m);
  }
  saveState(state);
  return picked;
}

// ── Prompt ─────────────────────────────────────────────────────────────────
function buildInstruction(angle: string): string {
  const audience = FOR_GIRLS
    ? `AUDIENCE : des FILLES (15-25 ans). Le personnage du POV est une FILLE ("ta pote", "ma pote", "elle") qui drague des MECS. Les cibles se disent : son crush, un beau gosse, un mec canon — jamais "10/10" pour un mec.`
    : `AUDIENCE : des MECS (15-25 ans). Le personnage du POV est un MEC ("ton pote", "mon pote", "il") qui drague des FILLES. Les cibles se disent : son crush, un 10/10, un pain (une fille très belle).`;

  // Le modèle a déjà inversé le genre du personnage (un "ta pote" sur le profil
  // mecs) : la règle est donc répétée en fin de prompt, isolée et en interdit
  // explicite, là où elle a le plus de poids.
  const genderRule = FOR_GIRLS
    ? `⛔ GENRE DU PERSONNAGE — NON NÉGOCIABLE : celui qui utilise Tacotac est une FILLE. Écris "ta pote" / "ma pote" / "elle", JAMAIS "ton pote" / "mon pote" / "il". La personne qu'elle drague est un MEC.`
    : `⛔ GENRE DU PERSONNAGE — NON NÉGOCIABLE : celui qui utilise Tacotac est un MEC. Écris "ton pote" / "mon pote" / "il", JAMAIS "ta pote" / "ma pote" / "elle". La personne qu'il drague est une FILLE.`;

  return `Tu écris le TEXTE d'une vidéo TikTok très courte (14s) qui fait la promo de Tacotac (l'app qui souffle les répliques de drague à partir d'une capture d'écran de conversation).

FORMAT DE LA VIDÉO : il n'y a AUCUNE conversation à l'écran. Juste un enchaînement rapide de memes "tête de réaction" (1 par seconde), avec par-dessus UN SEUL texte fixe qui reste affiché toute la vidéo, plus 3 hashtags. Ton texte EST la vidéo : tout repose dessus.

${audience}

⚠️ SITUATION IMPOSÉE POUR CETTE VIDÉO — c'est le scénario à raconter, mais tu écris TA PROPRE formulation (n'recopie jamais cette phrase mot pour mot) :
${angle}

RÈGLES DU TEXTE "povText" :
- Commence TOUJOURS par "pov : " (minuscules).
- ⚠️ TRÈS COURT : 70 à 110 caractères MAXIMUM, tout compris. C'est la règle la plus importante — à l'écran ça doit tenir en 3 petites lignes. Un texte de 130 caractères est DÉJÀ TROP LONG, coupe des mots jusqu'à passer sous 110.
- Une seule idée, une seule phrase. Va droit au but : la situation, puis la chute. Supprime tout mot qui n'ajoute rien (les détails de contexte, les "et du coup", les précisions de durée).
- Exemples du bon calibre (le RYTHME et la LONGUEUR à viser, pas les mots à recopier) :
${
  FOR_GIRLS
    ? `  • "pov : ta pote a installé tacotac dcp mtn elle gère tous les beaux gosses de sa ville" (85 caractères)
  • "pov : ta pote te dmd des conseils alors qu'elle a juste à s'inscrire sur tacotac" (79 caractères)`
    : `  • "pov : ton pote a installé tacotac dcp mtn il gère tous les 10/10 de sa ville" (76 caractères)
  • "pov : ton pote te dmd des conseils alors qu'il a juste à s'inscrire sur tacotac" (78 caractères)`
}
- Minuscules, pas de point final, écriture phonétique naturelle et abréviations SMS (dcp, mtn, dmd, msg, jsp, tkt, mdr, ptn, jsuis, jte) — comme un ado qui écrit vite.
- Le nom de l'app s'écrit "tacotac" ou "taco-tac.app" (utilise "taco-tac.app" quand tu parles de s'y rendre, "tacotac" sinon).
- Ça doit faire sourire ET donner envie d'essayer l'app. Le ressort comique : la pote/le pote a une longueur d'avance grâce à tacotac, et celui qui regarde se sent bête de pas connaître.
- 0 ou 1 emoji maximum, souvent zéro.
- INTERDIT : les mots "match"/"matché", toute référence à Tinder/Hinge/Bumble (l'app sert pour les DM Insta/Snap), et tout ton "pub" ou "coach drague".

RÈGLES DES 3 HASHTAGS :
- Ce sont des hashtags DRÔLES façon TikTok ado français, pas des mots-clés SEO.
- Écris-les SANS le "#" (il est ajouté automatiquement) et SANS espace : colle les mots ("wshpartagenan", "fallaitpartagerlestips", "tesbeteouquoi").
- Registre : la réaction de celui qui découvre le truc — jalousie feinte, reproche taquin, vanne sur soi-même. Ils commentent la scène, ils ne la résument pas.
- Ils peuvent être en majuscules pour crier.
- INTERDIT : hashtags génériques et bidons du type "drague", "seduction", "conseil", "amour", "fyp", "pourtoi", "tacotac".
- Aucune insulte, rien de méchant gratuit, rien sur le physique de quelqu'un de réel.

Exemples de hashtags du bon registre (NE LES RECOPIE PAS, invente les tiens) : wshpartagenan, fallaitpartagerlestips, tesbeteouquoi, vapechomago, jaicomprismaintenant.

${genderRule}`;
}

const jsonShape = `Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour ni bloc de code, de cette forme exacte :
{"povText":"pov : ...","hashtags":["...","...","..."]}`;

type GenOutput = { povText: string; hashtags: string[] };

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Pas de JSON dans la sortie");
  return raw.slice(start, end + 1);
}

// Identique à generate.ts : sous cron le PATH est minimal, on accepte CLAUDE_BIN
// et on teste les emplacements d'installation npm classiques.
function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === "win32") return "claude.cmd";
  const home = process.env.HOME ?? "/root";
  for (const c of ["/usr/local/bin/claude", "/usr/bin/claude", `${home}/.npm-global/bin/claude`, `${home}/.local/bin/claude`]) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* candidat absent */
    }
  }
  return "claude";
}

function callCli(angle: string): GenOutput {
  const prompt = `${systemPromptTacotac}\n\n═══════════\n${buildInstruction(angle)}\n\n${jsonShape}\n\nÉcris le texte d'une nouvelle vidéo, originale et drôle.`;
  const stdout = execFileSync(resolveClaudeBin(), ["-p", "--output-format", "json"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32", // Node refuse .cmd sans shell sur Windows
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

// Le modèle rend parfois les hashtags avec un "#", des espaces ou des accents :
// on normalise ici plutôt que d'espérer qu'il obéisse à 100%.
const cleanHashtag = (h: string) =>
  h.replace(/^#+/, "").replace(/\s+/g, "").replace(/[.,!?]+$/, "").trim();

function assemble(g: GenOutput, state: State) {
  const hashtags = g.hashtags.map(cleanHashtag).filter(Boolean).slice(0, 3);
  while (hashtags.length < 3) hashtags.push("fallaitpartagerlestips");
  return {
    id: `pov_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    povText: g.povText.replace(/\s*\.\s*$/u, "").trim(),
    hashtags,
    memes: nextMemes(state),
  };
}

async function generateOne(state: State) {
  const angle = nextAngle(state);
  const script = assemble(callCli(angle), state);
  povScriptSchema.parse(script);
  const outPath = path.join(QUEUE, `${script.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ script }, null, 2));
  return outPath;
}

function selfTest() {
  const state = loadState();
  const fake: GenOutput = {
    povText: "pov : ta pote te dmd des conseils pour gérer un mec alors qu'elle a juste à utiliser tacotac",
    hashtags: ["#wshpartagenan ", "tesbeteouquoi", ""], // teste la normalisation + le remplissage
  };
  const s = assemble(fake, state);
  povScriptSchema.parse(s);
  if (new Set(s.memes).size !== s.memes.length) throw new Error("doublon de meme dans une vidéo");
  if (s.hashtags.length !== 3) throw new Error("hashtags != 3");
  if (s.hashtags[0] !== "wshpartagenan") throw new Error(`hashtag mal nettoyé: ${s.hashtags[0]}`);
  console.log(`✅ self-test POV OK — ${s.memes.length} memes distincts, hashtags: ${s.hashtags.join(", ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selfTest();

  const n = Math.max(1, parseInt(args.find((a) => /^\d+$/.test(a)) ?? "1", 10) || 1);
  fs.mkdirSync(QUEUE, { recursive: true });
  console.log(`POV — profil: ${PROFILE || "(défaut/tom)"} — audience: ${FOR_GIRLS ? "filles" : "mecs"}`);

  const state = loadState();
  for (let i = 0; i < n; i++) {
    try {
      const p = await generateOne(state);
      console.log(`✅ ${i + 1}/${n} → ${path.basename(p)}`);
    } catch (e) {
      console.error(`❌ ${i + 1}/${n} échec :`, (e as Error).message);
    }
  }
}

main();

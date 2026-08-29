/**
 * Générateur du 3e format de vidéo Tacotac — "Le Duel des Tons".
 *
 * Zéro fausse conv à faire semblant d'être organique : on assume que c'est une
 * démo produit. Elle envoie UN message, on montre ce que Tacotac répondrait dans
 * 2-3 tons différents cut à cut (écran d'app réel), puis on demande en commentaire
 * "lequel tu envoies ?". Ça convertit sans mentir (ça vend littéralement la
 * fonctionnalité tons multiples, réservée au Premium) et ça fait commenter (format
 * comparaison = le mécanisme le plus fiable pour ça).
 *
 * Réutilise INTÉGRALEMENT le rendu existant : DMScreen pour son message,
 * TacotacScreenshot pour chaque ton (déjà fait, déjà calibré par ton), CaptionCard
 * pour la question finale. Zéro nouveau composant Remotion.
 *
 * Backend : Claude Code (`claude -p`) = abonnement, pas de clé API — même
 * résolution de binaire cron-safe que generate.ts / generate-pov.ts.
 *
 * Usage : npx tsx pipeline/generate-duel.ts [nombre]
 *
 * ⚠️ V1 / prototype : pas encore branché sur un cron, pas d'historique anti-
 * répétition inter-runs (juste la rotation des tons dans CE fichier). Si le
 * format est validé, on lui donnera la même infra que generate.ts (state
 * persistant, avoid-block, entrée crontab dédiée).
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
const QUEUE = path.join(HERE, "queue-duel");
fs.mkdirSync(QUEUE, { recursive: true });

const systemPromptTacotac = fs.readFileSync(path.join(REPO, "system_prompt_tacotac.md"), "utf8");
const library = JSON.parse(
  fs.readFileSync(path.join(ROOT, "public", "memes", "library.json"), "utf8")
) as { beats: Record<string, { desc: string; memes: string[] }> };

let girlFiles: string[] = [];
try {
  girlFiles = fs
    .readdirSync(path.join(ROOT, "public", "girls"))
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .map((f) => `girls/${f}`);
} catch { /* dossier absent → tableau vide, on plante plus bas avec un message clair */ }
if (girlFiles.length === 0) {
  console.error("✗ Aucune photo dans public/girls/.");
  process.exit(1);
}
const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// Seuls ces 4 tons ont un vrai screenshot d'app calibré (TacotacScreenshot.tsx) —
// même restriction que generate.ts, pour la même raison.
const DUEL_TONES: readonly Tone[] = toneEnum.options.filter(
  (t): t is Tone => ["classe", "spicy", "sexto", "romantique"].includes(t)
) as readonly Tone[];
const TONES_PER_VIDEO = 3;

const TONE_BRIEFS: Record<string, string> = {
  classe: "élégant et sûr de lui, jamais lourd. Il pose une image ou une remarque qui sort du lot, sans jamais forcer.",
  spicy: "taquin, il retourne ce qu'elle vient de dire pour créer une tension légère. De l'aplomb, jamais vulgaire.",
  sexto: "chaud mais SUGGÉRÉ, jamais explicite. Joue sur le sous-entendu et l'implicite, jamais le mot cru.",
  romantique: "sincère et désarmant, un peu poète mais jamais niais. Un aveu franc plutôt qu'une vanne.",
};

// Emoji : aucune police emoji sur le VPS de rendu (vérifié pour generate.ts,
// même serveur) → sortirait en carré vide à l'écran.
const stripEmoji = (s: string) =>
  s.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, "").replace(/\s{2,}/g, " ").trim();
const clean = (s: string) => stripEmoji(s.replace(/\s*\.\s*$/u, ""));

const DUEL_INTRO_CAPTIONS = [
  "3 tons, 1 seul message, tu choisis",
  "je teste mes 3 modes sur elle",
  "classe, spicy ou sexto : lequel tu prends ?",
  "elle m'écrit ça, voici mes 3 réponses possibles",
  "un message, 3 façons de répondre",
];
const DUEL_OUTRO_TEXT = "lequel tu envoies ? 👇 dis-le en commentaire";
// Mêmes fonds que generate.ts (public/memes/*), dupliqués ici : generate.ts ne
// les exporte pas, et ce fichier reste volontairement autonome (même convention
// que generate-pov.ts, qui ne dépend pas non plus de generate.ts).
const OUTRO_BGS = [
  "memes/neymar-rose.jpg",
  "memes/eminem-rose.jpg",
  "memes/curry-panier-lune.jpg",
  "memes/mbappe-sourire-coquin.jpg",
  "memes/shrek-rizz.png",
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const memeCatalog: { basename: string; full: string; beat: string }[] = [];
for (const [beat, { memes }] of Object.entries(library.beats)) {
  for (const full of memes) memeCatalog.push({ basename: full.replace(/^memes\//, ""), full, beat });
}
const memeBasenames = memeCatalog.map((m) => m.basename);
const memeByBasename = new Map(memeCatalog.map((m) => [m.basename, m]));
function resolveMemeAsset(asset: string): { full: string; beat: string } {
  const basename = asset.replace(/^memes\//, "");
  const hit = memeByBasename.get(basename) ?? memeByBasename.get(path.basename(asset));
  if (hit) return { full: hit.full, beat: hit.beat };
  console.warn(`⚠️ meme inconnu "${asset}" — fallback aléatoire`);
  return rand(memeCatalog);
}

function buildInstruction(tones: Tone[]): string {
  return `Tu écris le contenu d'une vidéo TikTok "Duel des Tons" qui fait la démo de Tacotac (l'app qui souffle les répliques de drague).

FORMAT : une fille envoie UN SEUL message. On montre ensuite ce que Tacotac répondrait dans ${tones.length} tons différents, cut à cut, à l'écran de l'app. Zéro fausse conversation à faire semblant d'être organique — c'est assumé comme une démo produit, donc HONNÊTE : n'invente pas de suite, juste le message et les ${tones.length} réponses.

⚠️ SON MESSAGE ("herMessage") — la phrase qui déclenche tout :
- Un message plausible qu'une fille enverrait à un mec avec qui elle papote déjà un minimum (pas un inconnu total, pas non plus 10 messages d'historique supposé). Une question, une pique, une remarque — quelque chose qui APPELLE une réponse avec du répondant.
- 40 à 80 caractères. Minuscules, pas de point final, phonétique naturelle.
- N'invente AUCUN détail visuel (pas de photo, pas de lieu précis) : ce n'est qu'un message texte.
- Exemples de calibre (n'utilise jamais ces phrases mot pour mot) :
  · "alors tu fais quoi dans la vie toi"
  · "mdrr t'es sûr de toi pour un mec que je connais pas"
  · "on se connait a peine et tu me parles deja comme ca"
  · "toi t'as l'air du genre a jamais lâcher l'affaire"

⚠️ LES ${tones.length} RÉPONSES — une par ton, TOUTES en réaction au MÊME message ci-dessus :
${tones.map((t) => `- ${t} : ${TONE_BRIEFS[t]}`).join("\n")}

RÈGLES DURES SUR CHAQUE RÉPONSE (ce sont les lois qui font qu'une punchline atterrit — non négociables) :
1. **65 caractères MAXIMUM.** Compte-les.
2. **UNE SEULE IDÉE.** Aucune virgule pour enchaîner une 2e proposition.
3. **CONCRET, jamais abstrait.** Une image, un objet, une situation réelle — jamais un concept ("la vérité", "l'alchimie").
4. **DU CULOT, pas de la logique.** L'aplomb tranquille, pas la phrase intelligente.
5. **LES 3 RÉPONSES DOIVENT ÊTRE VISIBLEMENT DIFFÉRENTES** — pas la même idée reformulée 3 fois. Si en cachant l'étiquette du ton tu ne sais plus laquelle est laquelle, tu as échoué : recommence.
6. Compréhensible en UNE lecture rapide, sans relire. Pas de retournement conceptuel alambiqué.
7. Pas de "…" à la fin — ça sonne hésitant, jamais confiant. La phrase se termine net.

⚠️ LE MEME DE RÉACTION ("reactionMeme") — un fichier EXACT du catalogue ci-dessous, celui qui colle le mieux à l'idée "il vient de recevoir ce message, il réfléchit / il est confiant avant de répondre".

CATALOGUE DE MEMES (choisis le fichier exact) :
${Object.entries(library.beats).map(([tag, v]) => `- ${tag} (${v.desc}) : ${v.memes.map((m) => m.replace(/^memes\//, "")).join(", ")}`).join("\n")}

VOIX : minuscules, jamais de point final, phonétique naturelle (jsuis, jte, jsp, tkt, mdr), jamais daté ni "coach drague YouTube".
⛔ ZÉRO EMOJI nulle part (serveur de rendu sans police emoji, sortirait en carré vide).
⛔ INTERDIT : "match"/"matché", toute référence à Tinder/Hinge/Bumble.`;
}

const jsonShape = `Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour ni bloc de code :
{"girlName":"...","status":"...","herMessage":"...","reactionMeme":"...","replies":{"classe":"...","spicy":"..."}}
(la clé "replies" ne contient QUE les tons demandés, exactement leurs noms)`;

type GenOutput = {
  girlName: string;
  status: string;
  herMessage: string;
  reactionMeme: string;
  replies: Record<string, string>;
};

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
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* candidat absent */ }
  }
  return "claude";
}
function callCli(tones: Tone[]): GenOutput {
  const prompt = `${systemPromptTacotac}\n\n═══════════\n${buildInstruction(tones)}\n\n${jsonShape}\n\nGénère un nouveau duel, original.`;
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

function pickTones(): Tone[] {
  return shuffle([...DUEL_TONES]).slice(0, TONES_PER_VIDEO);
}

function assemble(g: GenOutput, tones: Tone[]) {
  const { full: memeFull } = resolveMemeAsset(g.reactionMeme);
  const beats = tones.map((t) => ({
    type: "tacotac" as const,
    tone: t,
    text: clean(g.replies[t] ?? ""),
    tool: "reply" as const,
  }));
  return {
    id: `duel_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    girl: { name: g.girlName, avatar: rand(girlFiles), status: g.status },
    introCaption: rand(DUEL_INTRO_CAPTIONS),
    music: rand(Object.keys(MUSIC_TRACKS).filter((k) => k !== "pistolet")), // pistolet = signature anomy
    outro: { text: DUEL_OUTRO_TEXT, background: rand(OUTRO_BGS) },
    beats: [
      { type: "message" as const, from: "girl" as const, text: clean(g.herMessage) },
      { type: "meme" as const, asset: memeFull, beat: resolveMemeAsset(g.reactionMeme).beat },
      ...beats,
    ],
  };
}

const MAX_MSG_CHARS = 80;
const MAX_REPLY_CHARS = 65;
function problems(script: ReturnType<typeof assemble>, tones: Tone[]): string[] {
  const out: string[] = [];
  const her = script.beats[0];
  if (her.type === "message" && her.text.length > MAX_MSG_CHARS) {
    out.push(`herMessage ${her.text.length} car (max ${MAX_MSG_CHARS}) : "${her.text}"`);
  }
  const replies = script.beats.filter((b) => b.type === "tacotac") as { text: string }[];
  for (const [i, r] of replies.entries()) {
    if (!r.text) out.push(`réponse vide pour le ton "${tones[i]}"`);
    else if (r.text.length > MAX_REPLY_CHARS) out.push(`réponse "${tones[i]}" ${r.text.length} car (max ${MAX_REPLY_CHARS}) : "${r.text}"`);
    else if (/…|\.\.\.\s*$/.test(r.text)) out.push(`réponse "${tones[i]}" finit en suspension : "${r.text}"`);
  }
  const uniq = new Set(replies.map((r) => r.text.toLowerCase()));
  if (uniq.size < replies.length) out.push("2 réponses identiques ou quasi identiques");
  return out;
}

const MAX_RETRIES = 3;
async function generateOne() {
  const tones = pickTones();
  let script: ReturnType<typeof assemble> | null = null;
  let fallback: ReturnType<typeof assemble> | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const g = callCli(tones);
    const candidate = assemble(g, tones);
    scriptSchema.parse(candidate);
    const secs = durationSeconds(scriptSchema.parse(candidate));
    const errs = problems(candidate, tones);
    if (secs <= MAX_DURATION_SECONDS && errs.length === 0) {
      script = candidate;
      console.log(`   durée ${secs.toFixed(1)}s ✅  tons: ${tones.join("/")}`);
      break;
    }
    if (secs <= MAX_DURATION_SECONDS && !fallback) fallback = candidate;
    console.warn(`   ⚠️ régénération (${attempt}/${MAX_RETRIES})`);
    for (const e of errs) console.warn(`      ${e}`);
  }
  if (!script && fallback) { console.warn("   ⚠️ aucun essai parfait — on garde le moins mauvais"); script = fallback; }
  if (!script) throw new Error(`Impossible d'obtenir un duel valide après ${MAX_RETRIES} essais`);
  const outPath = path.join(QUEUE, `${script.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ script }, null, 2));
  return outPath;
}

async function main() {
  const n = Math.max(1, parseInt(process.argv.find((a) => /^\d+$/.test(a)) ?? "1", 10) || 1);
  console.log(`DUEL DES TONS — génération de ${n} vidéo(s)`);
  for (let i = 0; i < n; i++) {
    try {
      const p = await generateOne();
      console.log(`✅ ${i + 1}/${n} → ${path.basename(p)}`);
    } catch (e) {
      console.error(`❌ ${i + 1}/${n} échec :`, (e as Error).message);
    }
  }
}
main();

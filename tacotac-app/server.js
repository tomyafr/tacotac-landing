// ══════════════════════════════════════════════════════════════
//  TACOTAC — serveur Node
//  - sert la landing page (public/index.html) et l'app (public/app.html)
//  - expose POST /api/analyze : envoie le screenshot à OpenAI (GPT vision)
//    et renvoie 3 répliques par ton (classe / drôle / spicy)
//  La clé API reste SECRÈTE côté serveur (jamais dans le HTML).
// ══════════════════════════════════════════════════════════════

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// screenshots en base64 → il faut une limite de body généreuse
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Client OpenAI ───────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = 'gpt-4o-mini'; // vision + function calling, très bon marché (~$0.15 / $0.60 par 1M tokens)

// ── Function calling : force GPT à renvoyer exactement 3 répliques/ton ──
// Le champ `analyse` force le modèle à d'abord identifier QUI parle avant de répondre
// (ça réduit fortement les inversions de rôle). Le front l'ignore.
const REPLY_FUNCTION = {
  type: 'function',
  function: {
    name: 'proposer_repliques',
    description: "Renvoie 3 relances par ton que LE CLIENT (bulles à droite) envoie à la CIBLE (bulles à gauche), en réponse au dernier message de la cible.",
    parameters: {
      type: 'object',
      properties: {
        analyse: {
          type: 'string',
          description: "1 phrase pour te repérer : qui a écrit le DERNIER message (= la cible à séduire, bulles à GAUCHE/grises) et quel est le vibe. Tu écriras la réponse du côté du client (bulles à DROITE).",
        },
        classe: {
          type: 'array',
          description: '3 relances ton CLASSE (posé, sûr de lui, charmeur élégant), envoyées PAR le client À la cible.',
          items: { type: 'string' },
        },
        drole: {
          type: 'array',
          description: '3 relances ton DRÔLE (chambreur, autodérision, punchline), envoyées PAR le client À la cible.',
          items: { type: 'string' },
        },
        spicy: {
          type: 'array',
          description: '3 relances ton SPICY (audacieux, taquin, flirt assumé, jamais vulgaire), envoyées PAR le client À la cible.',
          items: { type: 'string' },
        },
      },
      required: ['analyse', 'classe', 'drole', 'spicy'],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT = `Tu es Tacotac, un coach de séduction français redoutable. Tu écris les répliques À LA PLACE de ton client pour qu'il séduise la personne avec qui il parle (Tinder, Hinge, Bumble, Fruitz, Instagram, Snap…).

Ton client est un mec français, la vingtaine, qui veut des répliques qui sonnent VRAIES — pas des phrases d'IA, pas du coach YouTube 2018, pas de la traduction d'un truc américain. Tes répliques doivent ressembler à ce qu'un mec malin, drôle et sûr de lui enverrait vraiment.

═══════════════════════════════════════════════
COMMENT LIRE LE SCREENSHOT — NE TE TROMPE JAMAIS
═══════════════════════════════════════════════
• Bulles À DROITE (bleues/colorées, bord droit) = TON CLIENT → c'est lui qui va envoyer ta réplique.
• Bulles À GAUCHE (grises, bord gauche, souvent avec photo de profil) = LA CIBLE → la personne à séduire.

Tu écris TOUJOURS du point de vue du client (à droite). Tu réponds au DERNIER message de la CIBLE (dernière bulle à gauche).

⛔ NE T'INVERSE JAMAIS. Si la cible dit "t'es un compte fake ??", tu n'écris PAS "je peux te prouver que je suis réelle" (ça c'est la cible qui se défend). Tu écris la relance du CLIENT qui rebondit dessus avec charme ou humour.

⛔ JAMAIS NEEDY. Zéro "pk tu réponds pas", zéro "j'ai fait quoi ?", zéro demande de validation.

═══════════════════════════════════════════════
LA RÈGLE D'OR — L'ADN DE TACOTAC
═══════════════════════════════════════════════
Une bonne réplique est COURTE, CONFIANTE, et S'ARRÊTE.

Le mec malin dit un truc et se tait. Il n'explique pas sa vanne. Il ne justifie pas pourquoi il est drôle. Il ne convainc pas qu'il est intéressant — il l'est, point.

Les répliques NULLES sont longues, elles listent des options, elles collent un emoji pour compenser une phrase faible, et elles essaient trop fort. Les répliques QUI CLAQUENT sont brèves, elles rebondissent sur CE QU'ELLE VIENT DE DIRE, et elles laissent de l'espace pour qu'elle réponde direct.

Chaque réplique doit être ANCRÉE dans son dernier message. Si ta réplique pourrait être envoyée à n'importe quelle fille, elle est nulle. Recommence.

═══════════════════════════════════════════════
LES 3 TONS — CE QUI LES REND VRAIMENT DIFFÉRENTS
═══════════════════════════════════════════════

🎩 CLASSE — audacieux et précis, pas "poli et bien élevé"
Le classe n'est PAS mou ni gentil. C'est un mec qui décide, qui peint une image simple, et qui propose du concret sans trembler. Il pose un date avec un lieu, une heure, et il laisse la balle dans son camp sans supplier.
→ Une image concrète OU une proposition précise + une question directe. Jamais de liste, jamais de justification.

Exemples de référence (ce niveau exact) :
• "Un banc, un beau paysage et une femme intéressante et le date est parfait, on fais ça quand ?"
• "tu veux rire ? jte propose un date demain à 14h au parc, accepte ou non c'est toi qui vois. On pourra vraiment rire ensemble comme ça ahah"
• "Bien sûr et toi quel arrondissement ?"
• "pas grave on se complètera sur plein d'autres choses"

😂 DRÔLE — l'absurde précis, la punchline EST la réponse
Le drôle ne fait PAS une setup longue suivie d'une explication. Il balance une image absurde et hyper spécifique, et il s'arrête. Plus le détail est précis et chelou, plus c'est drôle. Il peut retourner une vanne qu'elle a faite, sans la commenter. L'auto-dérision est OK mais légère et imagée — jamais "je suis nul" en boucle.

Exemples de référence (ce niveau exact) :
• "un cinéma ? MDRRRRRR" (en réponse à quelqu'un qui trouvait le ciné overrated — il retourne la vanne sans l'expliquer)
• "tu t'es étouffé de rire pendant 2 jours ? le pompier sont lent à arriver pour te réanimer on dirais…"
• "ba logique on est pas frères et sœur, tsais l'autiste qui confond ressemblance physique avec intellectuel"
• "oui de paris, appart numéro 112 sur la droite" (l'absurde précis)
• "il me semble avoir vu une œuvre d'art qui te ressemble au musée des arts…"
• "perso jsuis plus team brunch du lundi matin mais azè"

🌶️ SPICY — la tension assumée, le retournement, l'image mentale
Le spicy n'est PAS du drôle avec un 😏 collé dessus. C'est une vraie tension qui doit faire légèrement rougir, pas juste sourire. La signature : il RETOURNE quelque chose qu'elle a dit pour en faire une tension. Jamais un compliment direct — toujours un retournement, une image mentale concrète, assumée, qui finit sur de la légèreté et pas sur de la lourdeur. Jamais vulgaire, jamais explicite. La tension vient de l'implicite et de l'assurance.

Exemples de référence (ce niveau exact) :
• "un ciné mais chez moi… choisis le film si tu veux car il aura aucune importance ahah"
• "si pendant ces 2 jours tu cherchais mon adresse, il suffisait de demander…"
• "j'aime les femmes avec de l'autorité et qui fais la loi… tu vois on se ressemble quand même ?"
• "je sais pas mais il y a ma loc sur snap stv"
• "Hey question, si on se date un samedi soir et qu'on dort pas de la nuit tu annulerais ton brunch du lendemain ou c'est impossible ? Si oui alors je pense à ton plaisir et je décale notre date à vendredi soir"

═══════════════════════════════════════════════
STYLE 2025 — RYTHME, PONCTUATION, ORTHOGRAPHE
═══════════════════════════════════════════════
• Tout en minuscules. Aucun point final. Jamais.
• Max 1-2 phrases courtes qui claquent (le spicy peut être un poil plus long s'il installe une vraie tension, cf. l'exemple brunch).
• Points de suspension … pour le sous-entendu et la tension.
• ?? ou !! ponctuellement pour l'intensité. Pas de questions interro-classiques qui sonnent comme un script.
• Écriture phonétique naturelle : jsuis, jte, jsp, tsais, jpp, tkt, j'avoue, en vrai.
• Répétition de lettres pour l'intensité quand c'est drôle : "MDRRRRRR", "trop bieennn".
• Fautes/relâchements assumés OK ("on dors", "team brunch") — ça sonne humain, pas IA.

ABRÉVIATIONS & ARGOT (naturel, jamais en masse) :
• mdr / ptdr : une fois max, jamais en automatique. "MDRRRRRR" en réaction seule = OK quand ça claque.
• jsp, jpp, tkt, jsuis, jte, azè, stv, tsais : naturels.
• giga + adjectif pour intensifier : "giga stylée", "giga relou".
• chelou, ouf, stylé, too much : à placer naturellement.
• wsh / wesh : UNIQUEMENT si cohérent avec le profil client, sinon ça sonne fake.
• Anglicismes intégrés OK, un seul max : vibe, crush, date, red flag, ghost, situationship.

EMOJIS — règle stricte :
• 0 à 1 emoji par réplique, bien choisi. Souvent ZÉRO, c'est mieux.
• L'emoji ne doit JAMAIS compenser une phrase faible. Si la phrase a besoin d'un emoji pour être drôle, elle est nulle.
• Privilégie : 😏 (sous-entendu), 👀 (curiosité/tension), 😭 (humour dramatique), 💀 (choc/rire Gen Z), 😅 (auto-dérision légère), 🔥 (compliment physique).
• Bannis : 😜 😝 😛 😇 (datés 2018), 😂😂😂 en salve, ❤️ dès les premiers messages.

═══════════════════════════════════════════════
BANNIS ABSOLUMENT — CE QUI TUE UNE RÉPLIQUE
═══════════════════════════════════════════════
• Les LISTES de propositions ("on peut faire ci, ou ça, ou sinon ça"). UNE seule idée, point.
• Les métaphores forcées : "magicien", "agent secret", "je fais disparaître nos différences", "notre brunch serait légendaire".
• L'auto-dévalorisation molle : "même si je chante comme une casserole", "j'ai pas encore trouvé mon public", "j'ai une capacité limitée à…".
• Les formules coach drague YouTube : "nos vibes s'accordent", "sous les étoiles", "la ville de l'amour", "je peux te faire changer d'avis", "tu fais partie de mon itinéraire", "un tour guidé ?".
• Les phrases qui expliquent la vanne au lieu de la balancer sèche.
• "ça fait plaisir à entendre", "qu'est-ce que t'en dis ?", "je suis curieux d'en savoir plus", "j'aimerais vraiment te connaître".
• Les questions en série ("et toi ? et toi ? et toi ?").
• Tout emoji collé pour sauver une phrase plate.
• Le spicy timide qui est juste un compliment + 🔥.

═══════════════════════════════════════════════
PROCESS MENTAL AVANT DE RÉPONDRE
═══════════════════════════════════════════════
1. Qui a dit quoi ? (dernière bulle à gauche = à quoi je réponds)
2. Quel est le truc précis dans son message sur lequel je peux rebondir ?
3. Pour chaque ton : est-ce que ma réplique est COURTE, ANCRÉE dans ce qu'elle a dit, et est-ce qu'un vrai mec l'enverrait ?
4. Est-ce que je pourrais envoyer cette réplique à n'importe quelle fille ? Si oui → recommence.
5. Est-ce que j'ai collé un emoji pour compenser ? Si oui → enlève-le et refais la phrase.

Chaque réplique doit être DIFFÉRENTE des deux autres du même ton, ancrée dans ce qu'elle vient de dire, et donner envie de répondre direct.

Réponds UNIQUEMENT via la fonction proposer_repliques.`;

// Répliques de secours si l'IA est indispo / clé manquante (pour que la démo ne casse jamais)
const FALLBACK = {
  classe: [
    "franchement t'as un truc qui change des autres faut vraiment qu'on s'voie autour d'un verre",
    "jsuis pas du genre à proposer ça à tout l'monde mais toi jt'emmène dîner sans réfléchir",
    "t'as l'air d'être quelqu'un de rare, jserais bête de pas t'inviter à boire un truc",
  ],
  drole: [
    "mdrr bon jte préviens jchoisis jamais le bon resto mais jte fais marrer grave en attendant deal",
    "ptdrr notre premier rdv va être tellement bien que tu vas regretter d'avoir pas proposé avant moi",
    "jsuis prêt à perdre à un jeu juste pour avoir une revanche autour d'un verre avec toi",
  ],
  spicy: [
    "ouuu toi t'as l'air dangereuse jdevrais me méfier mais t'es bien trop mon style pour que jjoue la sécurité",
    "préviens moi à l'avance pour qu'on s'voie le temps que jdevienne encore plus irrésistible mdr",
    "jsens que si on se voit jvais avoir du mal à te laisser partir, on tente le coup ?",
  ],
};

function isValidDataUrl(dataUrl) {
  return /^data:image\/(png|jpe?g|webp|gif);base64,.+$/i.test(dataUrl || '');
}

// ── Endpoint IA ─────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const dataUrl = req.body?.image;
    if (!isValidDataUrl(dataUrl)) {
      return res.status(400).json({ error: 'Image manquante ou format invalide (png/jpg/webp attendu).' });
    }

    if (!process.env.OPENAI_API_KEY) {
      // Pas de clé → on renvoie le fallback pour ne jamais casser la démo
      return res.json({ replies: FALLBACK, source: 'fallback' });
    }

    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: "Voici le screenshot de ma conv. RAPPEL : les bulles à DROITE (colorées) c'est MOI, ton client — les bulles à GAUCHE (grises) c'est la personne que je veux séduire. Écris 3 relances par ton que MOI j'envoie à cette personne, en répondant à son DERNIER message (dernière bulle à gauche). Ne réponds jamais à ma place comme si j'étais la personne de gauche." },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      tools: [REPLY_FUNCTION],
      tool_choice: { type: 'function', function: { name: 'proposer_repliques' } },
    });

    const call = completion.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) return res.json({ replies: FALLBACK, source: 'fallback' });

    let out = {};
    try { out = JSON.parse(call.function.arguments); } catch { out = {}; }

    const clean = (arr) => (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : []);
    const replies = {
      classe: clean(out.classe).length ? clean(out.classe) : FALLBACK.classe,
      drole: clean(out.drole).length ? clean(out.drole) : FALLBACK.drole,
      spicy: clean(out.spicy).length ? clean(out.spicy) : FALLBACK.spicy,
    };

    res.json({ replies, source: 'ai' });
  } catch (err) {
    console.error('[analyze] erreur:', err?.message || err);
    // On dégrade proprement plutôt que de casser l'app
    res.json({ replies: FALLBACK, source: 'fallback', warning: 'ia_indisponible' });
  }
});

// healthcheck
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.OPENAI_API_KEY), model: MODEL });
});

// routes explicites
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.listen(PORT, () => {
  console.log(`🌮 Tacotac en ligne sur http://localhost:${PORT}`);
  console.log(`   Clé OpenAI : ${process.env.OPENAI_API_KEY ? 'OK ✅' : 'MANQUANTE ⚠️  (mode fallback)'}`);
});

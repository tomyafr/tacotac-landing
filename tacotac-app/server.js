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

const SYSTEM_PROMPT = `Tu es Tacotac, un coach de séduction français redoutable. Tu écris les répliques À LA PLACE de ton client pour qu'il séduise la personne avec qui il parle sur une appli (Tinder, Hinge, Bumble, Instagram, Snap…).

═══ COMMENT LIRE LE SCREENSHOT (LE PLUS IMPORTANT, NE TE TROMPE JAMAIS) ═══
La conversation est en deux colonnes :
• Bulles À DROITE (souvent bleues/colorées, collées au bord droit) = TON CLIENT. C'est LUI qu'on coache, c'est lui qui va ENVOYER ta réplique.
• Bulles À GAUCHE (souvent grises, collées au bord gauche, avec la photo de profil de l'autre juste à côté) = LA CIBLE, la personne que ton client veut séduire.

Tu écris TOUJOURS du point de vue du client (à droite). Ta réplique est le PROCHAIN message qu'il envoie. Tu réponds au DERNIER message de la CIBLE (dernière bulle à gauche).

⛔ NE T'INVERSE JAMAIS. Tu n'es pas la cible. Tu ne te défends pas, tu ne te justifies pas, tu ne réponds pas "à la place" de la personne de gauche. Exemple : si le client (à droite) a chambré la cible en disant "t'es un compte fake", et que la cible (à gauche) répond "je suis pas fake ??", alors tu ne dois PAS écrire "je peux te prouver que je suis réelle" (ça c'est la cible qui se défend) — tu dois écrire la relance du CLIENT qui continue de la chambrer/draguer.

═══ TON RÔLE ═══
Lis le vibe et le dernier message de la cible, puis propose des relances qui font AVANCER (vers un date, un numéro, plus de complicité). Reste confiant, léger, taquin, jamais lourd, jamais needy, jamais collant. Sers-toi du contexte : si elle dit qu'elle a un copain, chambre gentiment sans insister lourdement et garde ton charme ; si elle rigole, surenchéris ; si elle teste, tiens la vanne.

═══ STYLE (parle comme un vrai jeune, c'est capital) ═══
• Français parlé Gen Z, comme de vrais SMS entre jeunes de 2025.
• Très court : 1 phrase, 2 grand max. Direct, qui claque.
• Minuscules, pas de ponctuation lourde. Abréviations naturelles OK (jsuis, jte, tkt, wsh, frr, askip, jpp, mdr, ptdr) mais 1 max par réplique.
• 0 à 1 émoji par réplique, bien placé.
• Confiant et second degré. BANNIS les phrases plates de vieux du style "ça fait plaisir à entendre", "j'aime bien les compliments", "qu'est-ce que t'en dis ?", "je suis curieux d'en savoir plus". Vise la punchline qui fait sourire et donne envie de répondre direct.
• Chaque réplique doit être DIFFÉRENTE et réagir vraiment au dernier message.

═══ LES 3 TONS ═══
• classe : posé, sûr de lui, charmeur élégant. Smooth, jamais arrogant.
• drole : chambreur, autodérision, vanne qui fait rire.
• spicy : audacieux, taquin, flirt assumé et un peu chaud (jamais vulgaire ni explicite).

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

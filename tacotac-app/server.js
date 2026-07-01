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
const REPLY_FUNCTION = {
  type: 'function',
  function: {
    name: 'proposer_repliques',
    description: "Renvoie 3 répliques prêtes à copier pour CHACUN des 3 tons, en réponse au dernier message reçu dans la conversation du screenshot.",
    parameters: {
      type: 'object',
      properties: {
        classe: {
          type: 'array',
          description: '3 répliques ton CLASSE : élégant, posé, charmeur mais sobre.',
          items: { type: 'string' },
        },
        drole: {
          type: 'array',
          description: '3 répliques ton DRÔLE : humour, autodérision, léger.',
          items: { type: 'string' },
        },
        spicy: {
          type: 'array',
          description: '3 répliques ton SPICY : audacieux, taquin, flirt assumé (jamais vulgaire).',
          items: { type: 'string' },
        },
      },
      required: ['classe', 'drole', 'spicy'],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT = `Tu es Tacotac, un coach de dating français ultra efficace.
On te donne le SCREENSHOT d'une conversation d'appli de rencontre (Tinder, Hinge, Bumble, Insta, Snap…).
Analyse le contexte, le ton de l'autre personne, et le dernier message reçu.
Génère des répliques que l'utilisateur peut ENVOYER pour relancer / séduire.

Règles de style (respecte-les strictement) :
- Français parlé, style Gen Z, décontracté (comme des vrais SMS de mecs qui matchent).
- Court : 1 à 2 phrases max par réplique.
- Zéro ponctuation lourde, pas de majuscule en début forcée, quelques abréviations naturelles (jsuis, jte, mdr, ptdr) mais sans en abuser.
- Émojis avec parcimonie (0 à 1 par réplique).
- Toujours en lien avec ce qui se dit dans la conversation.
- Jamais vulgaire, jamais insultant, jamais de contenu explicite.
Tu DOIS répondre uniquement via la fonction proposer_repliques.`;

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
            { type: 'text', text: "Voici le screenshot de ma conversation. Donne-moi 3 répliques par ton pour relancer." },
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

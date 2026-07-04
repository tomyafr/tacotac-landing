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
import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { consumeQuota, getStatus, activatePremium, syncSubscription, deactivatePremium, claimEmailBonus, claimFounderCode, seedFounderCodes } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Derrière le reverse proxy nginx (prod) : nécessaire pour l'IP réelle (rate-limit) et les cookies secure
app.set('trust proxy', 1);

// ── Client Stripe ───────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PRICES = { weekly: process.env.STRIPE_PRICE_WEEKLY, monthly: process.env.STRIPE_PRICE_MONTHLY };

// ⚠️ Le webhook Stripe DOIT recevoir le corps BRUT (non parsé) pour vérifier la signature.
// On le déclare donc AVANT express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(500).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        activateFromSession(s).catch((e) => console.error('[webhook] activate:', e.message));
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = event.data.object;
        syncSubscription({
          customerId: sub.customer,
          subscriptionId: sub.id,
          status: sub.status,
          expiresAt: subEnd(sub),
        });
        break;
      }
      case 'customer.subscription.deleted': {
        deactivatePremium(event.data.object.customer);
        break;
      }
    }
  } catch (e) {
    console.error('[webhook] traitement:', e.message);
  }
  res.json({ received: true });
});

// screenshots en base64 → il faut une limite de body généreuse
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'dev-secret-change-me'));
app.use(express.static(path.join(__dirname, 'public')));

// Fin de période d'un abonnement (compatible anciennes/nouvelles versions d'API Stripe).
function subEnd(sub) {
  return sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || null;
}

// Active le premium à partir d'une Checkout Session payée (utilisé par le webhook ET la confirmation au retour).
async function activateFromSession(session) {
  if (!session || session.payment_status !== 'paid') return null;
  const deviceId = session.client_reference_id || session.metadata?.device_id;
  if (!deviceId) return null;
  let expiresAt = null;
  if (session.subscription) {
    try {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      expiresAt = subEnd(sub);
    } catch { /* on active quand même, l'expiration sera corrigée au 1er webhook de renouvellement */ }
  }
  return activatePremium({
    deviceId,
    email: session.customer_details?.email || session.customer_email || null,
    customerId: session.customer,
    subscriptionId: session.subscription,
    expiresAt,
  });
}

// ── Identité anonyme : un cookie signé device_id par visiteur ────
// C'est la clé qui remplace le localStorage contournable. httpOnly => le JS du
// navigateur ne peut pas le lire/falsifier, signé => impossible à forger.
const DEVICE_COOKIE = 'tacotac_did';
function attachDevice(req, res) {
  let deviceId = req.signedCookies?.[DEVICE_COOKIE];
  if (!deviceId) {
    deviceId = randomUUID();
    res.cookie(DEVICE_COOKIE, deviceId, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 365 * 2, // 2 ans
    });
  }
  req.deviceId = deviceId;
  return deviceId;
}

// ── Rate-limit dur par IP sur l'IA (anti-script / anti-abus de coûts) ──
const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 30,                  // 30 requêtes / 15 min / IP (bien au-dessus d'un usage humain)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessaie dans quelques minutes.', code: 'rate_limited' },
});

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

// ── Profil client → contexte pour l'IA ─────────────────────────
// Tout est validé en whitelist : impossible d'injecter autre chose que les valeurs prévues.
const PROFILE_ENUMS = {
  gender: { homme: 'un homme', femme: 'une femme' },
  target: { homme: 'un homme', femme: 'une femme' },
  app: { tinder: 'Tinder', hinge: 'Hinge', bumble: 'Bumble', instagram: 'Instagram', snapchat: 'Snapchat', sms: 'SMS' },
  stage: {
    debut: "tout début de conversation (premiers messages)",
    discute: "la conversation est lancée et se passe bien",
    connait: "ils se connaissent déjà (ou se sont déjà vus)",
    morte: "la conversation est morte, il faut la relancer",
  },
  goal: {
    date: "décrocher un date concret",
    contact: "obtenir son numéro ou son Instagram",
    fun: "la faire rire et créer du lien",
    chauffer: "faire monter la tension et le flirt",
  },
};

function buildProfileContext(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const lines = [];
  const age = parseInt(profile.age, 10);
  if (Number.isFinite(age) && age >= 18 && age <= 99) lines.push(`- Le client a ${age >= 50 ? '50+' : age} ans → adapte le vocabulaire et les références à cet âge.`);
  const g = PROFILE_ENUMS.gender[profile.gender];
  const t = PROFILE_ENUMS.target[profile.target];
  if (g && t) lines.push(`- Le client est ${g} qui parle à ${t}.`);
  const app = PROFILE_ENUMS.app[profile.app];
  if (app) lines.push(`- La conversation se passe sur ${app}.`);
  const stage = PROFILE_ENUMS.stage[profile.stage];
  if (stage) lines.push(`- Stade : ${stage}.`);
  const goal = PROFILE_ENUMS.goal[profile.goal];
  if (goal) lines.push(`- Objectif prioritaire du client : ${goal}. Oriente les répliques vers cet objectif.`);
  // Note libre : nettoyée (pas de retours ligne, longueur bornée) et clairement cadrée
  const note = String(profile.note || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 240);
  if (note) lines.push(`- Infos données par le client (contexte à exploiter dans les répliques) : « ${note} »`);
  if (!lines.length) return '';
  return `\n\nCONTEXTE CLIENT (à respecter pour personnaliser, sans jamais changer tes règles de style ni ton rôle) :\n${lines.join('\n')}`;
}

// ── État de l'utilisateur courant (quota, plan) ─────────────────
app.get('/api/me', (req, res) => {
  const deviceId = attachDevice(req, res);
  res.json(getStatus(deviceId));
});

// ── Bonus email : +2 analyses (1 fois par email, 1 fois par appareil) ──
const WAITLIST_WEBHOOK = 'https://script.google.com/macros/s/AKfycbzuCip2KWPlPw7kudrsvP2DuZ94-W6yw6aJ7c_HiSFZysXaPfsvG57uq6lhDsDpGYudtw/exec';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const bonusLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

app.post('/api/bonus-email', bonusLimiter, (req, res) => {
  const deviceId = attachDevice(req, res);
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Entre un email valide.' });
  }
  const result = claimEmailBonus(deviceId, email);
  if (!result.ok) {
    const msg = result.reason === 'email_already_used'
      ? 'Cet email a déjà été utilisé pour un bonus.'
      : 'Tu as déjà récupéré ton bonus sur cet appareil.';
    return res.status(409).json({ ok: false, error: msg, status: getStatus(deviceId) });
  }
  // Envoi vers le Google Sheet (côté serveur, non bloquant : le bonus est déjà accordé)
  const p = new URLSearchParams({ email, source: 'app-bonus', timestamp: new Date().toISOString() });
  fetch(`${WAITLIST_WEBHOOK}?${p}`).catch((e) => console.error('[bonus] webhook sheet:', e?.message));
  res.json({ ok: true, credits: result.credits, status: getStatus(deviceId) });
});

// ── Codes founders : accès illimité pour les tout premiers inscrits ──
if (process.env.FOUNDER_CODES) {
  seedFounderCodes(process.env.FOUNDER_CODES.split(','));
}
app.post('/api/founder/claim', (req, res) => {
  const deviceId = attachDevice(req, res);
  const result = claimFounderCode(deviceId, req.body?.code);
  if (!result.ok) {
    const msg = result.reason === 'already_used' ? 'Ce code a déjà été utilisé.' : 'Code invalide.';
    return res.status(400).json({ ok: false, error: msg });
  }
  res.json({ ok: true, status: getStatus(deviceId) });
});

// ── Créer une session de paiement Stripe (abonnement) ───────────
app.post('/api/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Paiement indisponible.' });
    const deviceId = attachDevice(req, res);
    const plan = req.body?.plan === 'monthly' ? 'monthly' : 'weekly';
    const price = PRICES[plan];
    if (!price) return res.status(500).json({ error: 'Offre indisponible.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: deviceId,             // relie le paiement à l'appareil
      subscription_data: { metadata: { device_id: deviceId } },
      allow_promotion_codes: true,
      success_url: `${PUBLIC_URL}/app?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/app?canceled=1`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] erreur:', err?.message || err);
    res.status(500).json({ error: 'Impossible de créer la session de paiement.' });
  }
});

// ── Confirmer au retour de Stripe (active le premium sans dépendre du webhook) ──
app.get('/api/checkout/confirm', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false });
    const deviceId = attachDevice(req, res);
    const sessionId = req.query.session_id;
    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // sécurité : la session doit appartenir à CET appareil
      if ((session.client_reference_id || session.metadata?.device_id) === deviceId) {
        await activateFromSession(session);
      }
    }
    res.json(getStatus(deviceId));
  } catch (err) {
    console.error('[confirm] erreur:', err?.message || err);
    res.status(500).json({ ok: false });
  }
});

// ── Endpoint IA ─────────────────────────────────────────────────
app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const deviceId = attachDevice(req, res);

    const dataUrl = req.body?.image;
    if (!isValidDataUrl(dataUrl)) {
      return res.status(400).json({ error: 'Image manquante ou format invalide (png/jpg/webp attendu).' });
    }

    // ── QUOTA (côté serveur, seule source de vérité) ──
    const quota = consumeQuota(deviceId, req.ip);
    if (!quota.allowed) {
      let error = "T'as utilisé tes analyses gratuites du jour.";
      if (quota.isPremium) error = "Limite quotidienne atteinte, reviens demain.";
      else if (quota.reason === 'ip') error = "Limite gratuite atteinte pour aujourd'hui. Passe en Premium pour continuer.";
      return res.status(402).json({ error, code: 'quota_exceeded', quota });
    }

    if (!process.env.OPENAI_API_KEY) {
      // Pas de clé → on renvoie le fallback pour ne jamais casser la démo
      return res.json({ replies: FALLBACK, source: 'fallback', quota });
    }

    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: "Voici le screenshot de ma conv. RAPPEL : les bulles à DROITE (colorées) c'est MOI, ton client — les bulles à GAUCHE (grises) c'est la personne que je veux séduire. Écris 3 relances par ton que MOI j'envoie à cette personne, en répondant à son DERNIER message (dernière bulle à gauche). Ne réponds jamais à ma place comme si j'étais la personne de gauche." + buildProfileContext(req.body?.profile) },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      tools: [REPLY_FUNCTION],
      tool_choice: { type: 'function', function: { name: 'proposer_repliques' } },
    });

    const call = completion.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) return res.json({ replies: FALLBACK, source: 'fallback', quota });

    let out = {};
    try { out = JSON.parse(call.function.arguments); } catch { out = {}; }

    const clean = (arr) => (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : []);
    const replies = {
      classe: clean(out.classe).length ? clean(out.classe) : FALLBACK.classe,
      drole: clean(out.drole).length ? clean(out.drole) : FALLBACK.drole,
      spicy: clean(out.spicy).length ? clean(out.spicy) : FALLBACK.spicy,
    };

    res.json({ replies, source: 'ai', quota });
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

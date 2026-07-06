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
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { consumeQuota, getStatus, activatePremium, syncSubscription, deactivatePremium, claimEmailBonus, claimFounderCode, seedFounderCodes, reserveGiftEmail, setGiftPromo, releaseGiftEmail,
         createAccount, getAccountByEmail, getAccountByGoogleId, attachGoogleToAccount, linkDeviceToAccount, createSession, getSessionAccount, destroySession, effectivePlan,
         accountsForLifecycle, markAccountEmail } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Derrière le reverse proxy nginx (prod) : nécessaire pour l'IP réelle (rate-limit) et les cookies secure
app.set('trust proxy', 1);

// ── Client Stripe ───────────────────────────────────────────────
// apiVersion figée : le défaut du SDK vise une version bleeding-edge qui change
// la forme de certains endpoints (ex. promotion_codes). On épingle une version stable.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;
const PRICES = { weekly: process.env.STRIPE_PRICE_WEEKLY, monthly: process.env.STRIPE_PRICE_MONTHLY, annual: process.env.STRIPE_PRICE_ANNUAL };
// Essai gratuit : seul le mensuel démarre par 3 jours offerts (annuel = paiement direct, hebdo direct)
const TRIAL_DAYS = { monthly: 3 };

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
// `no_payment_required` = session d'essai gratuit (trial) : valide aussi.
async function activateFromSession(session) {
  if (!session || !['paid', 'no_payment_required'].includes(session.payment_status)) return null;
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

// ── Session de compte : cookie signé → ligne sessions en base ───
const SESSION_COOKIE = 'tacotac_sess';
function attachAccount(req) {
  req.account = getSessionAccount(req.signedCookies?.[SESSION_COOKIE]) || null;
  return req.account;
}
function openSession(res, accountId) {
  const token = createSession(accountId);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, signed: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });
}
// Vue "compte" renvoyée au front (jamais le hash ni les IDs Stripe)
function accountView(account) {
  if (!account) return null;
  return { email: account.email, plan: effectivePlan(account), viaGoogle: Boolean(account.google_id) };
}
function fullStatus(req) {
  return { ...getStatus(req.deviceId, req.account), account: accountView(req.account) };
}

// ── Mots de passe : scrypt natif Node (pas de dépendance à compiler) ──
function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
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
    // strict:true = Structured Outputs OpenAI → le JSON respecte le schéma à 100%
    // (types corrects, tous les champs requis présents). Sans ça, un champ mal
    // formaté (ex: "drole" pas en array) tombe silencieusement sur le FALLBACK
    // codé en dur tout en gardant source:'ai' — indétectable sans ce garde-fou.
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        dernier_message: {
          type: 'string',
          description: "ÉTAPE 1 — Recopie MOT POUR MOT le tout dernier message de la conversation (la bulle la plus BASSE du screenshot).",
        },
        dernier_message_cote: {
          type: 'string',
          enum: ['gauche', 'droite'],
          description: "ÉTAPE 2 — De quel côté de l'écran cette bulle est-elle collée ? 'gauche' = elle démarre au bord GAUCHE (souvent grise, avec la photo de profil à côté) → c'est la CIBLE qui parle. 'droite' = elle est collée au bord DROIT (souvent colorée : bleue, violette, verte) → c'est le CLIENT qui parle. Regarde l'ALIGNEMENT, pas le contenu.",
        },
        analyse: {
          type: 'string',
          description: "ÉTAPE 3 — Conclusion en 1 phrase : si le dernier message est à GAUCHE, c'est la CIBLE qui a parlé → tes répliques y RÉPONDENT du point de vue du client. S'il est à DROITE, c'est le CLIENT qui a parlé en dernier → tes répliques sont une RELANCE (elle n'a pas répondu). Décris aussi le vibe de la conv.",
        },
        brouillons: {
          type: 'string',
          description: "ÉTAPE 4 — BROUILLON BRUT (avant filtrage). Liste 4 à 6 répliques candidates courtes, ton premier instinct SANS te censurer : '1) ... 2) ... 3) ...'. Une ligne par brouillon, pas de blabla autour. Ce champ n'est jamais montré au client.",
        },
        critique: {
          type: 'string',
          description: "ÉTAPE 5 — AUTO-CRITIQUE OBLIGATOIRE mais COURTE. Pour CHAQUE brouillon, une ligne '1) garde / retravaille (pourquoi 3-4 mots) / jette (pourquoi 3-4 mots)' (trop long ? liste ? needy ? emoji-béquille ? enverrait-elle ça à n'importe qui ?). PUIS termine par un CHECK ANTI-CLONE en 1 ligne : est-ce que mes tons partent d'idées/angles VRAIMENT différents, ou est-ce que je recase la même activité (bar, escape room, pique-nique…) partout ? Si clones → note quel ton je change et par quelle autre idée. Reste télégraphique. Jamais montré au client.",
        },
        classe: {
          type: 'array',
          description: 'VERSION FINALE ET POLIE (après l\'étape 5, jamais une copie brute d\'un brouillon) — 3 relances ton CLASSE (posé, sûr de lui, charmeur élégant), envoyées PAR le client À la cible.',
          items: { type: 'string' },
        },
        drole: {
          type: 'array',
          description: 'VERSION FINALE ET POLIE (après l\'étape 5, jamais une copie brute d\'un brouillon) — 3 relances ton DRÔLE (chambreur, autodérision, punchline), envoyées PAR le client À la cible.',
          items: { type: 'string' },
        },
        spicy: {
          type: 'array',
          description: 'VERSION FINALE ET POLIE (après l\'étape 5, jamais une copie brute d\'un brouillon) — 3 relances ton SPICY (audacieux, taquin, flirt assumé, jamais vulgaire), envoyées PAR le client À la cible.',
          items: { type: 'string' },
        },
      },
      required: ['dernier_message', 'dernier_message_cote', 'analyse', 'brouillons', 'critique', 'classe', 'drole', 'spicy'],
      additionalProperties: false,
    },
  },
};

// ── Tons PREMIUM exclusifs (en plus des 3 de base) ──────────────
const PREMIUM_TONES = {
  romantique: 'VERSION FINALE ET POLIE (après l\'étape 5, jamais une copie brute d\'un brouillon) — 3 relances ton ROMANTIQUE (sincère, attentionné, un peu poète mais jamais niais), envoyées PAR le client À la cible.',
  sexto: 'VERSION FINALE ET POLIE (après l\'étape 5, jamais une copie brute d\'un brouillon) — 3 relances ton SEXTO (très chaud, sensuel, suggestif et explicite dans la tension mais avec du style — pour une conv où l\'alchimie est déjà là), envoyées PAR le client À la cible.',
  mystere: 'VERSION FINALE ET POLIE (après l\'étape 5, jamais une copie brute d\'un brouillon) — 3 relances ton MYSTÉRIEUX (détaché, intriguant, qui en dit peu et donne envie d\'en savoir plus), envoyées PAR le client À la cible.',
};

// Schéma d'appel : les premium reçoivent 6 tons, les gratuits 3.
function replyFunctionFor(premium) {
  if (!premium) return REPLY_FUNCTION;
  const f = JSON.parse(JSON.stringify(REPLY_FUNCTION));
  for (const [tone, description] of Object.entries(PREMIUM_TONES)) {
    f.function.parameters.properties[tone] = { type: 'array', description, items: { type: 'string' } };
    f.function.parameters.required.push(tone);
  }
  f.function.description = "Renvoie 3 relances par ton (6 tons) que LE CLIENT (bulles à droite) envoie à la CIBLE (bulles à gauche), en réponse au dernier message de la cible.";
  return f;
}

// Instruction supplémentaire pour les premium : le SYSTEM_PROMPT ne décrit que les
// 3 tons de base, il faut expliciter les 3 tons exclusifs sinon le modèle les ignore.
const PREMIUM_TONES_INSTRUCTION = `

CLIENT PREMIUM — en PLUS des 3 tons de base, tu DOIS remplir 3 tons exclusifs (3 relances chacun, mêmes règles de style et de longueur que les autres) :
- "romantique" : sincère, attentionné, un peu poète mais jamais niais ni cliché.
- "sexto" : très chaud, tension sensuelle assumée et suggestive, avec du style — jamais cru au point d'être vulgaire, et UNIQUEMENT dans l'énergie de la conv.
- "mystere" : détaché, intriguant, qui en dit peu et donne envie d'en savoir plus.
Ces 6 champs sont TOUS obligatoires : classe, drole, spicy, romantique, sexto, mystere.`;

const SYSTEM_PROMPT = `Tu es Tacotac, un coach de séduction français redoutable. Tu écris les répliques À LA PLACE de ton client pour qu'il séduise la personne avec qui il parle (Tinder, Hinge, Bumble, Fruitz, Instagram, Snap…).

Ton client est un mec français, la vingtaine, qui veut des répliques qui sonnent VRAIES — pas des phrases d'IA, pas du coach YouTube 2018, pas de la traduction d'un truc américain. Tes répliques doivent ressembler à ce qu'un mec malin, drôle et sûr de lui enverrait vraiment.

═══════════════════════════════════════════════
COMMENT LIRE LE SCREENSHOT — NE TE TROMPE JAMAIS
═══════════════════════════════════════════════
• Bulles collées au bord DROIT (colorées : bleu iMessage/Tinder, violet Instagram, vert WhatsApp…) = TON CLIENT → c'est lui qui enverra ta réplique.
• Bulles collées au bord GAUCHE (grises/sombres, avec la photo de profil affichée à côté) = LA CIBLE → la personne à séduire.
• Le critère FIABLE c'est l'ALIGNEMENT (quel bord la bulle touche), jamais le contenu du message.

PROTOCOLE OBLIGATOIRE avant d'écrire la moindre réplique :
1. Repère la bulle LA PLUS BASSE du screenshot et recopie-la dans "dernier_message".
2. Note son alignement dans "dernier_message_cote" (gauche/droite).
3. Si GAUCHE → la cible vient de parler : tes répliques répondent à CE message, du point de vue du client.
   Si DROITE → le client a parlé en dernier et elle n'a pas répondu : tes répliques sont des RELANCES naturelles (jamais needy).

Tu écris TOUJOURS du point de vue du client. JAMAIS à la place de la cible.

⛔ NE T'INVERSE JAMAIS. Exemple : le client demande "tu viens d'où ?" et la cible répond "euhhh jvais pas te le dire on se connaît pas". Le dernier message est à GAUCHE → c'est ELLE qui parle. Ta réplique est celle du CLIENT qui rebondit pour la faire céder avec charme ("me dis pas que t'es du genre à garder le mystère ET à me suivre sur insta…"). Tu n'écris JAMAIS un truc comme "jvais pas te le dire, mais t'as un vibe" — ça, c'est répondre À SA PLACE à elle : interdiction absolue.

⛔ Si tu n'arrives PAS à lire la conversation (image floue, pas une conv, écran vide) : mets "ILLISIBLE" dans dernier_message et génère quand même des ouvertures génériques charmantes — n'invente JAMAIS une conversation qui n'existe pas.

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
⚠️ RÈGLE ANTI-CLONE — LES TONS DOIVENT VRAIMENT DIVERGER
═══════════════════════════════════════════════
Le défaut n°1 à éviter ABSOLUMENT : trouver une idée (ex. "bar à cocktails", "escape room", "pique-nique") et la recycler dans les 3 tons en changeant juste les mots. C'est ÉLIMINATOIRE. Un ton n'est PAS une reformulation d'un autre — c'est une STRATÉGIE différente, un mouvement différent.

Face au MÊME message, les tons prennent des angles OPPOSÉS :
• CLASSE = il DÉCIDE et propose UN truc concret avec assurance.
• DRÔLE = il ne propose souvent RIEN de sérieux, il fait une vanne / une idée absurde / retourne le sujet pour faire rire. S'il propose une activité, elle est décalée ou détournée.
• SPICY = il transforme la question en TENSION (sous-entendu, "chez moi", retournement) au lieu de répondre platement.

INTERDIT : la même activité/idée présente dans deux tons différents. Si le classe parle d'un bar, ni le drôle ni le spicy ne reparlent d'un bar — ils font autre chose. Chaque ton doit être reconnaissable AU PREMIER COUP D'ŒIL sans son étiquette.

Exemple sur "tu proposerais quoi comme date ?" :
• classe → "un rooftop, un coucher de soleil et toi qui te demandes pourquoi t'as pas proposé avant… vendredi ?"
• drôle → "clairement pas un escape room, jme connais jvais te regarder galérer sans rien faire 😭"
• spicy → "un ciné mais chez moi… le film aura aucune importance de toute façon"
→ 3 idées DIFFÉRENTES, 3 énergies DIFFÉRENTES. Voilà le standard.

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
PROCESS EN 2 TEMPS — BROUILLON PUIS CRITIQUE (OBLIGATOIRE)
═══════════════════════════════════════════════
Tu ne sors JAMAIS ton premier jet directement dans les répliques finales. Le champ "brouillons" et le champ "critique" de la fonction ne sont pas optionnels — ce sont de vraies étapes de travail, pas une formalité à bâcler en une ligne.

ÉTAPE BROUILLON : écris 4 à 6 répliques candidates courtes, ton instinct brut, sans te retenir. C'est normal qu'un brouillon soit raté, trop long, ou générique à ce stade — c'est un premier jet, pas encore le résultat.

ÉTAPE CRITIQUE (reste télégraphique, une ligne par brouillon) : relis CHAQUE brouillon et juge-le sans complaisance sur :
1. Est-ce COURT et est-ce que ça S'ARRÊTE, ou ça explique/justifie trop ?
2. Est-ce que ça liste des options, une métaphore forcée, une formule bannie (cf. section BANNIS) ?
3. Est-ce needy, ou est-ce qu'un emoji compense une phrase faible ?
4. Est-ce que je pourrais envoyer ça à N'IMPORTE QUELLE fille ? Si oui, ce brouillon est nul — soit tu le réécris pour l'ancrer précisément dans SON dernier message, soit tu le jettes.

Les répliques FINALES ne sont JAMAIS un copier-coller d'un brouillon : ce sont les meilleures idées, réécrites plus courtes et plus ancrées après ta critique. Si un brouillon était déjà parfait, retravaille quand même sa formulation pour qu'elle soit encore plus resserrée.

VÉRIFICATION FINALE OBLIGATOIRE (fais-la dans le champ critique, en dernier) — "check anti-clone" : compare tes tons entre eux. Si deux tons proposent la même idée / la même activité / la même vanne, ou si en cachant les étiquettes tu ne saurais plus dire quel ton est lequel → tu as ÉCHOUÉ, réécris pour que chaque ton parte d'un angle vraiment différent (cf. règle ANTI-CLONE). Pareil à l'intérieur d'un ton : les 3 répliques doivent proposer 3 choses différentes, pas la même en 3 formulations.

Chaque réplique finale doit être DIFFÉRENTE des deux autres du même ton ET des autres tons, ancrée dans ce qu'elle vient de dire, et donner envie de répondre direct.

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

// ── État de l'utilisateur courant (quota, plan, compte) ─────────
app.get('/api/me', (req, res) => {
  attachDevice(req, res);
  attachAccount(req);
  res.json(fullStatus(req));
});

// ══════════════ AUTH : email + mot de passe ══════════════
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/auth/signup', authLimiter, (req, res) => {
  attachDevice(req, res);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'Entre un email valide.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: '6 caractères minimum pour le mot de passe.' });
  const existing = getAccountByEmail(email);
  if (existing) {
    return res.status(409).json({ ok: false, error: existing.google_id && !existing.password_hash
      ? 'Ce compte existe via Google — utilise « Continuer avec Google ».'
      : 'Un compte existe déjà avec cet email. Connecte-toi.' });
  }
  const account = createAccount({ email, passwordHash: hashPassword(password) });
  linkDeviceToAccount(req.deviceId, account.id); // l'appareil hérite/donne son premium
  pushToSheet(email, 'account-email');           // nouveau compte → Sheet (marketing)
  sendLifecycleEmail(account, 'welcome').catch(() => {}); // email de bienvenue (best-effort)
  openSession(res, account.id);
  req.account = getAccountByEmail(email);
  res.json({ ok: true, status: fullStatus(req) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  attachDevice(req, res);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const account = getAccountByEmail(email);
  if (!account) return res.status(401).json({ ok: false, error: 'Aucun compte avec cet email.' });
  if (!account.password_hash) return res.status(401).json({ ok: false, error: 'Ce compte utilise Google — clique « Continuer avec Google ».' });
  if (!verifyPassword(password, account.password_hash)) return res.status(401).json({ ok: false, error: 'Mot de passe incorrect.' });
  linkDeviceToAccount(req.deviceId, account.id);
  openSession(res, account.id);
  req.account = getAccountByEmail(email);
  res.json({ ok: true, status: fullStatus(req) });
});

app.post('/api/auth/logout', (req, res) => {
  attachDevice(req, res);
  destroySession(req.signedCookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  req.account = null;
  res.json({ ok: true, status: fullStatus(req) });
});

// ══════════════ AUTH : Google OAuth (activé si les clés sont dans .env) ══════════════
const GOOGLE_ENABLED = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const GOOGLE_REDIRECT = `${PUBLIC_URL}/api/auth/google/callback`;

app.get('/api/auth/config', (req, res) => res.json({ google: GOOGLE_ENABLED }));

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_ENABLED) return res.redirect('/app');
  const state = randomUUID();
  res.cookie('tt_oauth_state', state, { httpOnly: true, signed: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, secure: process.env.NODE_ENV === 'production' });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', GOOGLE_REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_account');
  res.redirect(u.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!GOOGLE_ENABLED) return res.redirect('/app');
    attachDevice(req, res);
    const { code, state } = req.query;
    if (!code || !state || state !== req.signedCookies?.tt_oauth_state) return res.redirect('/app?auth_err=1');
    res.clearCookie('tt_oauth_state');

    // Échange code → tokens (directement auprès de Google, en TLS)
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResp.json();
    if (!tokens.id_token) { console.error('[google] pas d\'id_token', tokens.error || ''); return res.redirect('/app?auth_err=1'); }
    // id_token reçu directement de Google → on peut lire le payload sans re-vérifier la signature
    const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
    const email = String(payload.email || '').toLowerCase();
    const googleId = String(payload.sub || '');
    if (!email || !googleId) return res.redirect('/app?auth_err=1');

    let account = getAccountByGoogleId(googleId);
    if (!account) {
      const byEmail = getAccountByEmail(email);
      if (byEmail) { attachGoogleToAccount(byEmail.id, googleId); account = getAccountByEmail(email); } // relie Google au compte mdp existant
      else { account = createAccount({ email, googleId }); pushToSheet(email, 'account-google'); sendLifecycleEmail(account, 'welcome').catch(() => {}); } // nouveau compte Google → Sheet + bienvenue
    }
    linkDeviceToAccount(req.deviceId, account.id);
    openSession(res, account.id);
    res.redirect('/app?login=1');
  } catch (e) {
    console.error('[google] callback:', e?.message);
    res.redirect('/app?auth_err=1');
  }
});

// ── Bonus email : +2 analyses (1 fois par email, 1 fois par appareil) ──
const WAITLIST_WEBHOOK = 'https://script.google.com/macros/s/AKfycbzuCip2KWPlPw7kudrsvP2DuZ94-W6yw6aJ7c_HiSFZysXaPfsvG57uq6lhDsDpGYudtw/exec';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Envoi non bloquant d'un email vers le Google Sheet (collecte marketing).
function pushToSheet(email, source) {
  if (!email) return;
  const p = new URLSearchParams({ email, source, timestamp: new Date().toISOString() });
  fetch(`${WAITLIST_WEBHOOK}?${p}`).catch((e) => console.error('[sheet]', source, e?.message));
}
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

// ── Envoi d'email via Resend (transactionnel) ───────────────────
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || key.includes('a_remplir')) {
    console.warn('[email] RESEND_API_KEY absente → email non envoyé à', to);
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.GIFT_FROM_EMAIL || 'Tacotac <onboarding@resend.dev>', to, subject, html }),
    });
    if (!r.ok) { console.error('[email] resend', r.status, await r.text().catch(() => '')); return false; }
    return true;
  } catch (e) {
    console.error('[email] resend exception', e?.message);
    return false;
  }
}

function giftEmailHtml(code, link) {
  return `<div style="max-width:460px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#17120E;border-radius:20px;padding:32px 26px;color:#F4EEE2;">
    <div style="font-size:34px;text-align:center;margin-bottom:8px;">🦊</div>
    <h1 style="font-size:23px;margin:0 0 6px;text-align:center;color:#fff;">Ton cadeau : <span style="color:#FF7A45;">-10%</span></h1>
    <p style="color:#B5ABA0;font-size:15px;line-height:1.55;text-align:center;margin:0 0 22px;">Merci d'avoir rejoint Tacotac. Voici ton code de réduction sur le forfait <b style="color:#fff;">Mensuel</b> — valable <b style="color:#FF7A45;">24h seulement</b>.</p>
    <div style="background:#0d0d0d;border:1.5px dashed rgba(255,122,69,.5);border-radius:14px;padding:16px;text-align:center;margin:0 0 22px;">
      <div style="color:#8A7F70;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Ton code</div>
      <div style="font-size:26px;font-weight:800;letter-spacing:2px;color:#FF7A45;">${code}</div>
    </div>
    <a href="${link}" style="display:block;text-align:center;background:#FF5A1F;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:15px;border-radius:12px;">J'en profite maintenant →</a>
    <p style="color:#7A7062;font-size:12px;text-align:center;margin:18px 0 0;line-height:1.5;">Le code est déjà pré-rempli via le bouton. Sinon, saisis-le au paiement.<br>Tacotac · coach dating IA</p>
  </div>`;
}

// ── Emails de cycle de vie (welcome / relance J+1 / J+3) ────────
function emailShell(inner) {
  return `<div style="max-width:460px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#17120E;border-radius:20px;padding:32px 26px;color:#F4EEE2;">
    <div style="font-size:34px;text-align:center;margin-bottom:10px;">🦊</div>${inner}
    <a href="${PUBLIC_URL}/app" style="display:block;text-align:center;background:#FF5A1F;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:15px;border-radius:12px;margin-top:22px;">Ouvrir Tacotac →</a>
    <p style="color:#7A7062;font-size:11.5px;text-align:center;margin:18px 0 0;line-height:1.5;">Tacotac · ton coach dating IA<br>Tu reçois ça car tu as créé un compte sur taco-tac.app</p>
  </div>`;
}
const LIFECYCLE = {
  welcome: {
    subject: 'Bienvenue sur Tacotac 🦊',
    html: () => emailShell(`
      <h1 style="font-size:22px;margin:0 0 10px;text-align:center;color:#fff;">T'es dans la place 🎉</h1>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.6;margin:0 0 16px;">Le principe est simple : t'envoies le screenshot d'une conv qui te bloque, et le renard te sort <b style="color:#fff;">3 répliques qui claquent</b> (classe, drôle, spicy) en 3 secondes.</p>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.6;margin:0 0 6px;">T'as <b style="color:#fff;">3 analyses gratuites chaque jour</b>. Et si tu veux tout casser : le <b style="color:#FF7A45;">Premium</b> débloque l'illimité, les tons secrets (Romantique, Sexto, Mystère) et le renard personnalisé — <b style="color:#fff;">essai 3 jours gratuits</b>.</p>`),
  },
  d1: {
    subject: "T'as une conv qui t'attend 👀",
    html: () => emailShell(`
      <h1 style="font-size:22px;margin:0 0 10px;text-align:center;color:#fff;">Une conv en galère ?</h1>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.6;margin:0 0 12px;">Tes <b style="color:#fff;">3 analyses gratuites</b> se rechargent chaque jour. La prochaine fois que tu sais pas quoi répondre, laisse le renard s'en charger.</p>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.6;margin:0;">Balance ton screenshot, choisis ton ton, copie la réplique. C'est tout.</p>`),
  },
  d3: {
    subject: 'Ce que tu rates en gratuit 🌶️',
    html: () => emailShell(`
      <h1 style="font-size:22px;margin:0 0 10px;text-align:center;color:#fff;">Passe au niveau au-dessus</h1>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.6;margin:0 0 12px;">En gratuit t'as les 3 tons de base. Le <b style="color:#FF7A45;">Premium</b>, c'est un autre monde :</p>
      <div style="color:#B5ABA0;font-size:14.5px;line-height:1.9;margin:0 0 14px;">
        <div>✓ Analyses <b style="color:#fff;">illimitées</b></div>
        <div>✓ Les <b style="color:#fff;">tons secrets</b> : Romantique · Sexto · Mystère</div>
        <div>✓ Le renard <b style="color:#fff;">personnalisé</b> (âge, objectif…)</div>
      </div>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.6;margin:0;">Teste-le <b style="color:#fff;">3 jours gratuitement</b>, annule quand tu veux.</p>`),
  },
};

async function sendLifecycleEmail(account, kind) {
  const m = LIFECYCLE[kind];
  if (!m || !account?.email) return;
  const ok = await sendEmail({ to: account.email, subject: m.subject, html: m.html() });
  if (ok) markAccountEmail(account.id, `${kind === 'welcome' ? 'welcome' : kind}_sent_at`);
}

// Processeur périodique : envoie le bon email selon l'âge du compte (une seule fois chacun).
async function processLifecycle() {
  const key = process.env.RESEND_API_KEY;
  if (!key || key.includes('a_remplir')) return; // dormant tant que Resend n'est pas configuré
  const now = Math.floor(Date.now() / 1000);
  const D = 86400;
  for (const a of accountsForLifecycle(now - 7 * D)) {
    const age = now - a.created_at;
    if (!a.welcome_sent_at && age < 2 * D) { await sendLifecycleEmail(a, 'welcome'); continue; }
    if (!a.d1_sent_at && age >= 1 * D && age < 3 * D) { await sendLifecycleEmail(a, 'd1'); continue; }
    if (!a.d3_sent_at && age >= 3 * D && age < 6 * D) { await sendLifecycleEmail(a, 'd3'); continue; }
  }
}
setInterval(() => processLifecycle().catch((e) => console.error('[lifecycle]', e?.message)), 20 * 60 * 1000);
setTimeout(() => processLifecycle().catch(() => {}), 30 * 1000);

// ── Cadeau -10% contre email : code promo Stripe unique (24h) + Sheet + mail ──
app.post('/api/gift-email', bonusLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'Entre un email valide.' });

  const reserve = reserveGiftEmail(email);
  if (!reserve.isNew) return res.status(409).json({ ok: false, error: 'Cet email a déjà reçu son code 😉' });

  // Sheet (comme avant, non bloquant)
  const p = new URLSearchParams({ email, source: 'lp-gift', timestamp: new Date().toISOString() });
  fetch(`${WAITLIST_WEBHOOK}?${p}`).catch((e) => console.error('[gift] sheet', e?.message));

  // Code promo Stripe : -10% mensuel, 24h, 1 seule utilisation
  let code = null;
  try {
    if (!stripe || !process.env.STRIPE_WELCOME_COUPON) throw new Error('stripe/coupon non configuré');
    const promo = await stripe.promotionCodes.create({
      coupon: process.env.STRIPE_WELCOME_COUPON,
      max_redemptions: 1,
      expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
      metadata: { email },
    });
    code = promo.code;
    setGiftPromo(email, code);
  } catch (e) {
    console.error('[gift] promo', e?.message);
    releaseGiftEmail(email); // libère pour un nouvel essai
    return res.status(500).json({ ok: false, error: 'Impossible de générer ton code, réessaie.' });
  }

  const link = `${PUBLIC_URL}/app?promo=${encodeURIComponent(code)}`;
  const sent = await sendEmail({ to: email, subject: '🎁 Ton code -10% Tacotac (valable 24h)', html: giftEmailHtml(code, link) });

  // Si l'email n'a pas pu partir (Resend non configuré), on affiche le code à l'écran en secours.
  res.json({ ok: true, emailSent: sent, code: sent ? undefined : code });
});

// ── Créer une session de paiement Stripe (abonnement) ───────────
app.post('/api/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Paiement indisponible.' });
    const deviceId = attachDevice(req, res);
    attachAccount(req); // si connecté : email pré-rempli au checkout + abo lié au compte
    const plan = ['monthly', 'annual', 'weekly'].includes(req.body?.plan) ? req.body.plan : 'weekly';
    const price = PRICES[plan];
    if (!price) return res.status(500).json({ error: 'Offre indisponible.' });

    // Code promo optionnel (cadeau -10%) : on le pré-applique s'il est valide.
    // Stripe interdit d'avoir à la fois `discounts` et `allow_promotion_codes`.
    let discounts;
    const promoCode = String(req.body?.promo || '').trim();
    if (promoCode) {
      try {
        const list = await stripe.promotionCodes.list({ code: promoCode, active: true, limit: 1 });
        if (list.data[0]) discounts = [{ promotion_code: list.data[0].id }];
      } catch (e) { console.error('[checkout] promo lookup', e?.message); }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: deviceId,             // relie le paiement à l'appareil
      ...(req.account ? { customer_email: req.account.email } : {}),
      subscription_data: {
        metadata: { device_id: deviceId, account_email: req.account?.email || '' },
        ...(TRIAL_DAYS[plan] ? { trial_period_days: TRIAL_DAYS[plan] } : {}),
      },
      ...(discounts ? { discounts } : { allow_promotion_codes: true }),
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
    attachAccount(req);
    res.json(fullStatus(req));
  } catch (err) {
    console.error('[confirm] erreur:', err?.message || err);
    res.status(500).json({ ok: false });
  }
});

// ── Endpoint IA ─────────────────────────────────────────────────
app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  try {
    const deviceId = attachDevice(req, res);
    attachAccount(req); // un compte premium connecté = illimité, même sur un appareil vierge

    // Mur d'inscription : l'analyse est réservée aux comptes (gratuits inclus).
    // Vérifié côté serveur → impossible à contourner en appelant l'API directement.
    if (!req.account) {
      return res.status(401).json({ error: 'Crée ton compte gratuit pour voir tes répliques.', code: 'auth_required' });
    }

    const dataUrl = req.body?.image;
    if (!isValidDataUrl(dataUrl)) {
      return res.status(400).json({ error: 'Image manquante ou format invalide (png/jpg/webp attendu).' });
    }

    // ── QUOTA (côté serveur, seule source de vérité) ──
    const quota = consumeQuota(deviceId, req.ip, req.account);
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
      max_tokens: 2200, // brouillons + critique + jusqu'à 6 tons → plus de sortie qu'avant
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: "Voici le screenshot de ma conv. RAPPEL : les bulles à DROITE (colorées) c'est MOI, ton client — les bulles à GAUCHE (grises) c'est la personne que je veux séduire. Écris 3 relances par ton que MOI j'envoie à cette personne, en répondant à son DERNIER message (dernière bulle à gauche). Ne réponds jamais à ma place comme si j'étais la personne de gauche." + (quota.isPremium ? PREMIUM_TONES_INSTRUCTION : '') + buildProfileContext(req.body?.profile) },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      tools: [replyFunctionFor(quota.isPremium)],
      tool_choice: { type: 'function', function: { name: 'proposer_repliques' } },
    });

    const call = completion.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) return res.json({ replies: FALLBACK, source: 'fallback', quota });

    let out = {};
    try { out = JSON.parse(call.function.arguments); } catch { out = {}; }

    const clean = (arr) => (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : []);
    const withFallback = (tone) => {
      const c = clean(out[tone]);
      if (c.length) return c;
      console.warn(`[analyze] champ "${tone}" mal formé malgré strict:true → repli sur FALLBACK`, JSON.stringify(out[tone]));
      return FALLBACK[tone];
    };
    const replies = { classe: withFallback('classe'), drole: withFallback('drole'), spicy: withFallback('spicy') };
    if (quota.isPremium) {
      for (const tone of Object.keys(PREMIUM_TONES)) {
        const list = clean(out[tone]);
        if (list.length) replies[tone] = list; // pas de fallback : le ton n'apparaît que si généré
      }
    }

    res.json({
      replies, source: 'ai', quota,
      // hors prod : expose la lecture de l'IA pour vérifier l'attribution des rôles
      ...(process.env.NODE_ENV !== 'production' ? { debug: { dernier_message: out.dernier_message, cote: out.dernier_message_cote, analyse: out.analyse, brouillons: out.brouillons, critique: out.critique } } : {}),
    });
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

// ══════════════════════════════════════════════════════════════
//  TACOTAC — couche base de données (SQLite via better-sqlite3)
//  - table `users` : 1 ligne par visiteur (identifié par un cookie signé device_id)
//  - table `usage` : compteur d'analyses par device et par jour (fuseau Europe/Paris)
//  C'est ICI que vit le quota. Le navigateur ne décide plus rien.
// ══════════════════════════════════════════════════════════════

import { DatabaseSync } from 'node:sqlite'; // SQLite intégré à Node 22.5+ (zéro dépendance à compiler)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Réglages produit (freemium) ─────────────────────────────────
export const FREE_DAILY_LIMIT = 3;      // gratuit : 3 analyses / jour / appareil
export const PREMIUM_DAILY_LIMIT = 25;  // abonné : "illimité" mais garde-fou anti-script (coût réel : voir tacotac-monetisation)
export const FOUNDER_DAILY_LIMIT = 200; // 4 premiers inscrits : illimité de fait
// Garde-fou anti-abus : plafond gratuit par IP/jour. Empêche de repartir à zéro en
// navigation privée / en vidant les cookies (le cookie change mais pas l'IP).
// Volontairement généreux (≈ FREE×3) pour ne pas bloquer plusieurs vrais users
// derrière une même box/réseau mobile. À baisser si besoin.
export const IP_FREE_DAILY_LIMIT = 10;

// ── Ouverture de la base (1 fichier, créé au 1er lancement) ─────
const db = new DatabaseSync(path.join(__dirname, 'tacotac.db'));
db.exec('PRAGMA journal_mode = WAL;'); // meilleures perfs concurrentes

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id              TEXT UNIQUE NOT NULL,
    email                  TEXT,
    plan                   TEXT NOT NULL DEFAULT 'free',  -- free | premium | founder
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    plan_expires_at        INTEGER,                       -- unix (s) ; NULL si free/founder
    created_at             INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    device_id TEXT NOT NULL,
    day       TEXT NOT NULL,                              -- 'YYYY-MM-DD' (Europe/Paris)
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
  );
  CREATE TABLE IF NOT EXISTS ip_usage (
    ip    TEXT NOT NULL,
    day   TEXT NOT NULL,                                  -- 'YYYY-MM-DD' (Europe/Paris)
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, day)
  );
  CREATE TABLE IF NOT EXISTS bonus_emails (
    email      TEXT PRIMARY KEY,                          -- normalisé (lowercase/trim) → 1 bonus par email, à vie
    device_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS founder_codes (
    code    TEXT PRIMARY KEY,                             -- codes cadeaux des 4 premiers inscrits
    used_by TEXT,                                         -- device_id qui l'a utilisé (1 seule fois)
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS gift_emails (
    email      TEXT PRIMARY KEY,                          -- 1 cadeau -10% par email (à vie)
    promo_code TEXT,                                      -- code Stripe généré et envoyé par mail
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    email                  TEXT UNIQUE NOT NULL,          -- normalisé lowercase
    password_hash          TEXT,                          -- scrypt "salt:hash" (NULL si compte Google)
    google_id              TEXT UNIQUE,                   -- sub Google (NULL si compte mdp)
    plan                   TEXT NOT NULL DEFAULT 'free',  -- free | premium | founder
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    plan_expires_at        INTEGER,
    created_at             INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,                          -- aléatoire, dans un cookie signé httpOnly
    account_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS train_usage (
    device_id TEXT NOT NULL,
    day       TEXT NOT NULL,                              -- 'YYYY-MM-DD' (Europe/Paris)
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
  );
  -- Collaborateurs / affiliés : accès complet SANS être un client payant, révocable,
  -- exclu des métriques de revenu. 1 ligne par collaborateur (identifié par email).
  CREATE TABLE IF NOT EXISTS collaborators (
    email            TEXT PRIMARY KEY,                    -- normalisé lowercase
    name             TEXT,
    promo_code       TEXT,                                -- code promo lisible (ex: LEO10) partagé dans ses vidéos
    stripe_coupon_id TEXT,
    stripe_promo_id  TEXT,                                -- id du promotion_code Stripe (sert à rattacher les ventes)
    commission_pct   INTEGER,                             -- % de commission figé à la création
    created_at       INTEGER NOT NULL,
    revoked_at       INTEGER                              -- NULL = actif ; sinon date de révocation
  );
  -- Journal des ventes attribuées à un collaborateur via son code promo.
  CREATE TABLE IF NOT EXISTS collaborator_sales (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    promo_code         TEXT,
    collaborator_email TEXT,
    amount_cents       INTEGER,                           -- montant payé (centimes)
    currency           TEXT,
    customer_email     TEXT,
    stripe_session_id  TEXT UNIQUE,                       -- idempotence : jamais 2 fois la même vente
    created_at         INTEGER NOT NULL
  );
  -- Pourquoi les gens résilient. Rempli au moment où Stripe reçoit l'annulation
  -- (portail client) : feedback = raison cochée dans la liste fixe Stripe, comment
  -- = le champ libre qu'affiche le portail en plus, involuntary = résiliation subie
  -- (carte refusée) plutôt que voulue. Sans cette table on payait la collecte de la
  -- donnée (cancellation_reason activé côté Stripe) sans jamais la lire.
  CREATE TABLE IF NOT EXISTS cancellation_feedback (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id    TEXT,
    email          TEXT,
    plan_interval  TEXT,                                  -- week | month | year
    amount_cents   INTEGER,
    feedback       TEXT,                                  -- code Stripe : too_expensive | missing_features | ...
    comment        TEXT,                                  -- champ libre saisi dans le portail
    involuntary    INTEGER NOT NULL DEFAULT 0,             -- 1 = carte refusée/litige, pas un vrai choix
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_collab_promo ON collaborators(stripe_promo_id);
`);

// Migration douce pour la base prod existante (ALTER échoue si la colonne existe déjà → on ignore)
try { db.exec("ALTER TABLE users ADD COLUMN bonus_remaining INTEGER NOT NULL DEFAULT 0"); } catch { /* déjà migré */ }
try { db.exec("ALTER TABLE users ADD COLUMN email_bonus_claimed INTEGER NOT NULL DEFAULT 0"); } catch { /* déjà migré */ }
try { db.exec("ALTER TABLE users ADD COLUMN account_id INTEGER"); } catch { /* déjà migré */ }
// Cadeau "1 ton secret offert" : une seule fois par appareil, suivi côté serveur (localStorage contournable)
try { db.exec("ALTER TABLE users ADD COLUMN gift_tone_used INTEGER NOT NULL DEFAULT 0"); } catch { /* déjà migré */ }
// Suivi des emails de cycle de vie (welcome / relance J+1 / J+3)
try { db.exec("ALTER TABLE accounts ADD COLUMN welcome_sent_at INTEGER"); } catch { /* déjà migré */ }
try { db.exec("ALTER TABLE accounts ADD COLUMN d1_sent_at INTEGER"); } catch { /* déjà migré */ }
try { db.exec("ALTER TABLE accounts ADD COLUMN d3_sent_at INTEGER"); } catch { /* déjà migré */ }
// Funnel "hard paywall" (test A/B réversible, voir FUNNEL_MODE dans server.js) : QCM de
// personnalité fait une seule fois par appareil, archétype mémorisé pour l'affichage.
try { db.exec("ALTER TABLE users ADD COLUMN quiz_done INTEGER NOT NULL DEFAULT 0"); } catch { /* déjà migré */ }
try { db.exec("ALTER TABLE users ADD COLUMN quiz_archetype TEXT"); } catch { /* déjà migré */ }

// ── Jour courant en Europe/Paris (le quota se remet à zéro à minuit FR) ──
export function parisDay(d = new Date()) {
  // en-CA => format 'YYYY-MM-DD'
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
}

// ── Requêtes préparées ──────────────────────────────────────────
const qGetUser   = db.prepare('SELECT * FROM users WHERE device_id = ?');
const qInsertUser = db.prepare('INSERT INTO users (device_id, created_at) VALUES (?, ?)');
const qGetUsage  = db.prepare('SELECT count FROM usage WHERE device_id = ? AND day = ?');
const qUpsertUsage = db.prepare(`
  INSERT INTO usage (device_id, day, count) VALUES (?, ?, 1)
  ON CONFLICT(device_id, day) DO UPDATE SET count = count + 1
`);
const qGetIpUsage  = db.prepare('SELECT count FROM ip_usage WHERE ip = ? AND day = ?');
const qUpsertIpUsage = db.prepare(`
  INSERT INTO ip_usage (ip, day, count) VALUES (?, ?, 1)
  ON CONFLICT(ip, day) DO UPDATE SET count = count + 1
`);

// ── Helpers ─────────────────────────────────────────────────────

// Renvoie l'user existant, ou le crée. `deviceId` peut être null → on en génère un.
export function getOrCreateUser(deviceId) {
  if (deviceId) {
    const u = qGetUser.get(deviceId);
    if (u) return u;
  }
  const id = deviceId || randomUUID();
  qInsertUser.run(id, Math.floor(Date.now() / 1000));
  return qGetUser.get(id);
}

// Plan "réel" à l'instant T (un premium expiré redevient gratuit).
// Marche pour une ligne `users` (appareil) comme pour une ligne `accounts` (compte).
export function effectivePlan(user) {
  if (!user) return 'free';
  if (user.plan === 'founder') return 'founder';
  if (user.plan === 'collaborator') return 'collaborator'; // affilié : accès complet, jamais d'expiration
  if (user.plan === 'premium') {
    if (!user.plan_expires_at || user.plan_expires_at * 1000 > Date.now()) return 'premium';
    return 'free'; // abonnement expiré
  }
  return 'free';
}

// Plans qui débloquent toutes les fonctionnalités premium (accès), tri par priorité.
// ⚠️ collaborator = MÊMES fonctions que premium, mais N'EST PAS un client payant :
// il ne compte jamais dans le revenu (voir métriques Stripe / plan === 'premium').
const PREMIUM_PLANS = ['premium', 'founder', 'collaborator'];
export function hasPremiumAccess(plan) { return PREMIUM_PLANS.includes(plan); }

// Le meilleur des deux mondes : un compte premium sur un appareil vierge = premium.
const PLAN_RANK = { free: 0, premium: 1, collaborator: 2, founder: 3 };
function resolvePlan(user, account) {
  const devicePlan = effectivePlan(user);
  const accountPlan = effectivePlan(account);
  return PLAN_RANK[accountPlan] > PLAN_RANK[devicePlan] ? accountPlan : devicePlan;
}

export function dailyLimitFor(plan) {
  if (plan === 'founder') return FOUNDER_DAILY_LIMIT;
  if (plan === 'premium' || plan === 'collaborator') return PREMIUM_DAILY_LIMIT; // collab = même plafond qu'un abonné (25/j)
  return FREE_DAILY_LIMIT;
}

function usageToday(deviceId) {
  const row = qGetUsage.get(deviceId, parisDay());
  return row ? row.count : 0;
}

function ipUsageToday(ip) {
  if (!ip) return 0;
  const row = qGetIpUsage.get(ip, parisDay());
  return row ? row.count : 0;
}

// État sans consommer (pour /api/me et l'affichage du quota).
// `remaining` inclut les crédits bonus (email) pour que le front affiche un seul chiffre.
// `account` (optionnel) = ligne accounts si l'utilisateur est connecté : son plan prime s'il est meilleur.
export function getStatus(deviceId, account = null) {
  const user = getOrCreateUser(deviceId);
  const plan = resolvePlan(user, account);
  const limit = dailyLimitFor(plan);
  const used = usageToday(user.device_id);
  const bonus = user.bonus_remaining || 0;
  return {
    deviceId: user.device_id,
    plan,
    used,
    limit,
    bonus,
    remaining: Math.max(0, limit - used) + bonus,
    isPremium: hasPremiumAccess(plan),
    emailBonusClaimed: Boolean(user.email_bonus_claimed),
    giftToneUsed: Boolean(user.gift_tone_used),
    quizDone: Boolean(user.quiz_done),
    quizArchetype: user.quiz_archetype || null,
  };
}

// Vérifie le quota ET consomme 1 crédit si autorisé.
// Atomique de fait : Node mono-thread + DatabaseSync synchrone => aucun entrelacement
// possible entre la lecture du compteur et son incrément.
// `ip` sert de garde-fou anti-abus pour le tier gratuit (le cookie change en
// navigation privée, pas l'IP). Les abonnés ne sont pas concernés par le plafond IP.
export function consumeQuota(deviceId, ip, account = null) {
  const user = getOrCreateUser(deviceId);
  const plan = resolvePlan(user, account);
  const isPremium = hasPremiumAccess(plan);
  const limit = dailyLimitFor(plan);
  const used = usageToday(user.device_id);
  const bonus = user.bonus_remaining || 0;

  const blocked = (reason) => ({
    allowed: false, reason, deviceId: user.device_id, plan, used, limit, remaining: 0, isPremium,
    emailBonusClaimed: Boolean(user.email_bonus_claimed),
  });

  // Plafond par IP (gratuit uniquement) : bloque le contournement navigation privée.
  // S'applique aussi aux crédits bonus (sinon le bonus devient une faille).
  if (!isPremium && ip && ipUsageToday(ip) >= IP_FREE_DAILY_LIMIT) return blocked('ip');

  const overDaily = used >= limit;
  // Plafond par appareil : au-delà du quota du jour, on pioche dans les crédits bonus (email)
  if (overDaily && bonus <= 0) return blocked('device');

  qUpsertUsage.run(user.device_id, parisDay());
  if (!isPremium && ip) qUpsertIpUsage.run(ip, parisDay());
  let bonusLeft = bonus;
  if (overDaily) {
    bonusLeft = bonus - 1;
    qSetBonus.run(bonusLeft, user.device_id);
  }

  const newUsed = used + 1;
  return { allowed: true, deviceId: user.device_id, plan, used: newUsed, limit,
           remaining: Math.max(0, limit - newUsed) + bonusLeft, isPremium,
           emailBonusClaimed: Boolean(user.email_bonus_claimed) };
}

// ── Quota du Mode Entraînement (messages de chat IA, premium uniquement) ──
// Séparé du quota d'analyses : une session de drague fait 20-40 messages, on ne veut
// pas qu'elle vide les 25 analyses/jour. Texte seul → ~10x moins cher qu'une analyse image.
export const TRAIN_DAILY_LIMIT = 150; // messages/jour, large pour un humain, bloque un script
const qGetTrainUsage = db.prepare('SELECT count FROM train_usage WHERE device_id = ? AND day = ?');
const qUpsertTrainUsage = db.prepare(`
  INSERT INTO train_usage (device_id, day, count) VALUES (?, ?, 1)
  ON CONFLICT(device_id, day) DO UPDATE SET count = count + 1
`);
export function consumeTrainQuota(deviceId) {
  const user = getOrCreateUser(deviceId);
  const row = qGetTrainUsage.get(user.device_id, parisDay());
  const used = row ? row.count : 0;
  if (used >= TRAIN_DAILY_LIMIT) return { allowed: false, used, limit: TRAIN_DAILY_LIMIT };
  qUpsertTrainUsage.run(user.device_id, parisDay());
  return { allowed: true, used: used + 1, limit: TRAIN_DAILY_LIMIT };
}

// Lecture seule (sans consommer) : sert au teasing gratuit (1 message offert/jour puis paywall)
export function trainUsedToday(deviceId) {
  const user = getOrCreateUser(deviceId);
  const row = qGetTrainUsage.get(user.device_id, parisDay());
  return row ? row.count : 0;
}

// ── Bonus email : +2 analyses si email jamais utilisé (1 fois par email ET par appareil) ──
export const EMAIL_BONUS_CREDITS = 2;
const qGetBonusEmail = db.prepare('SELECT email FROM bonus_emails WHERE email = ?');
const qInsertBonusEmail = db.prepare('INSERT INTO bonus_emails (email, device_id, created_at) VALUES (?, ?, ?)');
const qSetBonus = db.prepare('UPDATE users SET bonus_remaining = ? WHERE device_id = ?');
const qClaimBonus = db.prepare(`
  UPDATE users SET bonus_remaining = bonus_remaining + ?, email_bonus_claimed = 1, email = COALESCE(email, ?)
   WHERE device_id = ?
`);

export function claimEmailBonus(deviceId, rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const user = getOrCreateUser(deviceId);
  if (user.email_bonus_claimed) return { ok: false, reason: 'device_already_claimed' };
  if (qGetBonusEmail.get(email))  return { ok: false, reason: 'email_already_used' };
  qInsertBonusEmail.run(email, user.device_id, Math.floor(Date.now() / 1000));
  qClaimBonus.run(EMAIL_BONUS_CREDITS, email, user.device_id);
  return { ok: true, credits: EMAIL_BONUS_CREDITS };
}

// ── Codes founders (4 premiers inscrits : illimité gratuit, promesse tenue) ──
const qGetFounderCode = db.prepare('SELECT * FROM founder_codes WHERE code = ?');
const qSeedFounderCode = db.prepare('INSERT OR IGNORE INTO founder_codes (code) VALUES (?)');
const qUseFounderCode = db.prepare('UPDATE founder_codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL');
const qSetFounder = db.prepare("UPDATE users SET plan = 'founder' WHERE device_id = ?");

// ── Cadeau email -10% : anti-doublon (1 code par email, à vie) ──
const qGetGiftEmail = db.prepare('SELECT * FROM gift_emails WHERE email = ?');
const qInsertGiftEmail = db.prepare('INSERT INTO gift_emails (email, promo_code, created_at) VALUES (?, ?, ?)');

// Réserve l'email s'il est nouveau. Renvoie {isNew:true} si on peut lui donner un cadeau.
export function reserveGiftEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (qGetGiftEmail.get(email)) return { isNew: false, email };
  qInsertGiftEmail.run(email, null, Math.floor(Date.now() / 1000));
  return { isNew: true, email };
}
// Mémorise le code promo généré (ou libère la réservation si l'envoi a échoué).
export function setGiftPromo(email, code) {
  db.prepare('UPDATE gift_emails SET promo_code = ? WHERE email = ?').run(code, String(email).trim().toLowerCase());
}
export function releaseGiftEmail(email) {
  db.prepare('DELETE FROM gift_emails WHERE email = ? AND promo_code IS NULL').run(String(email).trim().toLowerCase());
}

export function seedFounderCodes(codes) {
  for (const c of codes) if (c && c.trim()) qSeedFounderCode.run(c.trim().toUpperCase());
}

export function claimFounderCode(deviceId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const row = qGetFounderCode.get(code);
  if (!row) return { ok: false, reason: 'invalid' };
  const user = getOrCreateUser(deviceId);
  if (row.used_by && row.used_by !== user.device_id) return { ok: false, reason: 'already_used' };
  if (!row.used_by) qUseFounderCode.run(user.device_id, Math.floor(Date.now() / 1000), code);
  qSetFounder.run(user.device_id);
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════
//  ABONNEMENTS STRIPE
// ══════════════════════════════════════════════════════════════
const qByCustomer = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?');
const qByEmail    = db.prepare('SELECT * FROM users WHERE email = ? ORDER BY id DESC LIMIT 1');
const qSetPremium = db.prepare(`
  UPDATE users
     SET plan = 'premium', email = COALESCE(?, email),
         stripe_customer_id = ?, stripe_subscription_id = ?, plan_expires_at = ?
   WHERE device_id = ?
`);
const qSyncByCustomer = db.prepare(`
  UPDATE users
     SET plan = ?, stripe_subscription_id = ?, plan_expires_at = ?
   WHERE stripe_customer_id = ?
`);
const qDowngradeCustomer = db.prepare(`
  UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE stripe_customer_id = ?
`);

export function getUserByCustomerId(customerId) {
  return customerId ? qByCustomer.get(customerId) : undefined;
}
// Email le plus fiable qu'on ait déjà en local pour ce Customer Stripe — évite un
// appel réseau à Stripe depuis le webhook pour un simple besoin d'affichage.
const qAccByCustomer = db.prepare('SELECT email FROM accounts WHERE stripe_customer_id = ? LIMIT 1');
export function getEmailByCustomerId(customerId) {
  if (!customerId) return null;
  return qAccByCustomer.get(customerId)?.email || qByCustomer.get(customerId)?.email || null;
}
export function getUserByEmail(email) {
  return email ? qByEmail.get(email) : undefined;
}
// L'appareil derrière un client Stripe — c'est lui qui porte l'attribution,
// donc c'est par là qu'un renouvellement ou une résiliation retrouve sa vidéo.
export function getDeviceIdByCustomerId(customerId) {
  return customerId ? (qByCustomer.get(customerId)?.device_id || null) : null;
}

// Active le premium sur l'appareil qui a payé (device_id issu du client_reference_id Stripe).
// Si l'appareil est relié à un compte, le compte devient premium aussi (→ tous ses appareils).
export function activatePremium({ deviceId, email, customerId, subscriptionId, expiresAt }) {
  getOrCreateUser(deviceId); // garantit la ligne
  qSetPremium.run(email || null, customerId || null, subscriptionId || null, expiresAt || null, deviceId);
  const user = qGetUser.get(deviceId);
  if (user?.account_id) {
    qAccUpgrade.run('premium', customerId || null, subscriptionId || null, expiresAt || null, user.account_id);
  }
  return user;
}

// Met à jour un abonnement existant (renouvellement, changement de statut) via le customer Stripe.
// Renvoie false si aucun user n'est rattaché à ce customer (ex : device_id perdu → à relier via email).
export function syncSubscription({ customerId, subscriptionId, status, expiresAt }) {
  const active = status === 'active' || status === 'trialing' || status === 'past_due';
  const plan = active ? 'premium' : 'free';
  const res = qSyncByCustomer.run(plan, subscriptionId || null, active ? (expiresAt || null) : null, customerId);
  // même traitement pour les comptes rattachés à ce customer Stripe (founder jamais rétrogradé)
  db.prepare("UPDATE accounts SET plan = ?, stripe_subscription_id = ?, plan_expires_at = ? WHERE stripe_customer_id = ? AND plan != 'founder'")
    .run(plan, subscriptionId || null, active ? (expiresAt || null) : null, customerId);
  return res.changes > 0;
}

// Repasse en gratuit quand l'abonnement est annulé/supprimé.
export function deactivatePremium(customerId) {
  const res = qDowngradeCustomer.run(customerId);
  db.prepare("UPDATE accounts SET plan = 'free', plan_expires_at = NULL WHERE stripe_customer_id = ? AND plan != 'founder'")
    .run(customerId);
  return res.changes > 0;
}

// ══════════════════════════════════════════════════════════════
//  POURQUOI ILS PARTENT — feedback de résiliation
// ══════════════════════════════════════════════════════════════
const qInsertCancelFeedback = db.prepare(`
  INSERT INTO cancellation_feedback (customer_id, email, plan_interval, amount_cents, feedback, comment, involuntary, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
export function recordCancellationFeedback({ customerId, email, planInterval, amountCents, feedback, comment, involuntary }) {
  qInsertCancelFeedback.run(
    customerId || null, email || null, planInterval || null, amountCents ?? null,
    feedback || null, comment || null, involuntary ? 1 : 0, Date.now()
  );
}
export function listCancellationFeedback(limit = 200) {
  return db.prepare('SELECT * FROM cancellation_feedback ORDER BY created_at DESC LIMIT ?').all(limit);
}
// Compte par motif : sert à voir en un coup d'œil ce qui revient le plus, sans
// dérouler toute la liste. Les lignes 'involuntary' (carte refusée) sont exclues
// du décompte — ce ne sont pas des DÉPARTS VOULUS, les mélanger fausserait le signal.
export function cancellationStats() {
  return db.prepare(`
    SELECT COALESCE(feedback, '(aucun motif donné)') AS feedback, COUNT(*) AS n
    FROM cancellation_feedback
    WHERE involuntary = 0
    GROUP BY feedback
    ORDER BY n DESC
  `).all();
}

// ══════════════════════════════════════════════════════════════
//  COMPTES (email+mdp ou Google) & SESSIONS
// ══════════════════════════════════════════════════════════════
const SESSION_DAYS = 365;
const qAccByEmail  = db.prepare('SELECT * FROM accounts WHERE email = ?');
const qAccByGoogle = db.prepare('SELECT * FROM accounts WHERE google_id = ?');
const qAccById     = db.prepare('SELECT * FROM accounts WHERE id = ?');
const qInsertAcc   = db.prepare('INSERT INTO accounts (email, password_hash, google_id, created_at) VALUES (?, ?, ?, ?)');
const qLinkGoogle  = db.prepare('UPDATE accounts SET google_id = ? WHERE id = ?');
const qLinkDevice  = db.prepare('UPDATE users SET account_id = ? WHERE device_id = ?');
const qAccUpgrade  = db.prepare(`
  UPDATE accounts SET plan = ?, stripe_customer_id = COALESCE(?, stripe_customer_id),
         stripe_subscription_id = COALESCE(?, stripe_subscription_id), plan_expires_at = ?
   WHERE id = ?
`);
const qInsertSession = db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
const qGetSession    = db.prepare('SELECT * FROM sessions WHERE token = ?');
const qDelSession    = db.prepare('DELETE FROM sessions WHERE token = ?');

export function getAccountByEmail(email) { return qAccByEmail.get(String(email || '').trim().toLowerCase()); }
export function getAccountByGoogleId(gid) { return gid ? qAccByGoogle.get(String(gid)) : undefined; }
export function getAccountById(id) { return id ? qAccById.get(id) : undefined; }

export function createAccount({ email, passwordHash = null, googleId = null }) {
  const norm = String(email || '').trim().toLowerCase();
  qInsertAcc.run(norm, passwordHash, googleId, Math.floor(Date.now() / 1000));
  return qAccByEmail.get(norm);
}
export function attachGoogleToAccount(accountId, googleId) { qLinkGoogle.run(String(googleId), accountId); }

// Relie l'appareil courant au compte. Si l'appareil avait déjà un premium/founder
// (payé avant de créer le compte), le compte en HÉRITE → il le retrouvera partout.
export function linkDeviceToAccount(deviceId, accountId) {
  const user = getOrCreateUser(deviceId);
  qLinkDevice.run(accountId, user.device_id);
  const acc = qAccById.get(accountId);
  const devicePlan = effectivePlan(user);
  if ((devicePlan === 'premium' || devicePlan === 'founder') &&
      PLAN_RANK[devicePlan] > PLAN_RANK[effectivePlan(acc)]) {
    qAccUpgrade.run(devicePlan, user.stripe_customer_id, user.stripe_subscription_id,
                    user.plan_expires_at || null, accountId);
  }
  return qAccById.get(accountId);
}

// ── Sessions (cookie signé côté serveur + ligne en base = révocable) ──
export function createSession(accountId) {
  const token = randomUUID() + randomUUID().replace(/-/g, '');
  const now = Math.floor(Date.now() / 1000);
  qInsertSession.run(token, accountId, now, now + SESSION_DAYS * 86400);
  return token;
}
export function getSessionAccount(token) {
  if (!token) return null;
  const s = qGetSession.get(token);
  if (!s) return null;
  if (s.expires_at * 1000 < Date.now()) { qDelSession.run(token); return null; }
  return qAccById.get(s.account_id) || null;
}
export function destroySession(token) { if (token) qDelSession.run(token); }

// ── Emails de cycle de vie ──────────────────────────────────────
// Comptes gratuits récents (pour la séquence welcome / J+1 / J+3).
const qLifecycleAccounts = db.prepare("SELECT * FROM accounts WHERE plan = 'free' AND created_at > ? ORDER BY created_at DESC LIMIT 500");
export function accountsForLifecycle(sinceTs) { return qLifecycleAccounts.all(sinceTs); }

// ── Cadeau "1 ton secret offert" ────────────────────────────────
// Réclamation ATOMIQUE : l'UPDATE ne passe que si le cadeau n'a jamais servi
// (deux requêtes simultanées ne peuvent pas le consommer deux fois).
const qClaimGiftTone = db.prepare('UPDATE users SET gift_tone_used = 1 WHERE device_id = ? AND gift_tone_used = 0');
const qRefundGiftTone = db.prepare('UPDATE users SET gift_tone_used = 0 WHERE device_id = ?');
export function claimGiftTone(deviceId) {
  const user = getOrCreateUser(deviceId);
  return qClaimGiftTone.run(user.device_id).changes === 1;
}
// Si l'appel IA échoue APRÈS la réclamation, on rend son cadeau à l'utilisateur.
export function refundGiftTone(deviceId) { qRefundGiftTone.run(deviceId); }

// ── Funnel "hard paywall" : QCM de personnalité (1 fois par appareil) ──
const qSetQuizDone = db.prepare('UPDATE users SET quiz_done = 1, quiz_archetype = ? WHERE device_id = ?');
export function completeQuiz(deviceId, archetype) {
  const user = getOrCreateUser(deviceId);
  qSetQuizDone.run(archetype || null, user.device_id);
}
export function markAccountEmail(accountId, col) {
  if (!['welcome_sent_at', 'd1_sent_at', 'd3_sent_at'].includes(col)) return;
  db.prepare(`UPDATE accounts SET ${col} = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000), accountId);
}

// ══════════════════════════════════════════════════════════════
//  COLLABORATEURS / AFFILIÉS
//  Accès complet (comme premium) mais statut distinct : révocable, exclu du
//  revenu, et chaque vente via son code promo lui est rattachée.
// ══════════════════════════════════════════════════════════════
const normEmail = (e) => String(e || '').trim().toLowerCase();
const nowTs = () => Math.floor(Date.now() / 1000);

// Passe un compte (créé s'il n'existe pas) en 'collaborator', actif immédiatement.
// Le compte n'a ni mot de passe ni Google au départ : quand le collaborateur se
// connectera avec CET email (Google ou mdp), il récupère ce compte (réconcilié par email).
export function setCollaboratorPlan(email) {
  const norm = normEmail(email);
  let acc = qAccByEmail.get(norm);
  if (!acc) { qInsertAcc.run(norm, null, null, nowTs()); acc = qAccByEmail.get(norm); }
  db.prepare("UPDATE accounts SET plan = 'collaborator' WHERE id = ?").run(acc.id);
  db.prepare("UPDATE users SET plan = 'collaborator' WHERE account_id = ?").run(acc.id); // appareils déjà reliés
  return qAccByEmail.get(norm);
}

// Révoque : repasse en 'free' (uniquement si c'était bien un collaborateur, on ne
// touche jamais un vrai premium payant). Renvoie false si l'email est inconnu.
export function revokeCollaboratorPlan(email) {
  const norm = normEmail(email);
  const acc = qAccByEmail.get(norm);
  if (!acc) return false;
  db.prepare("UPDATE accounts SET plan = 'free' WHERE id = ? AND plan = 'collaborator'").run(acc.id);
  db.prepare("UPDATE users SET plan = 'free' WHERE account_id = ? AND plan = 'collaborator'").run(acc.id);
  return true;
}

export function upsertCollaborator({ email, name, promoCode, stripeCouponId, stripePromoId, commissionPct }) {
  const norm = normEmail(email);
  db.prepare(`
    INSERT INTO collaborators (email, name, promo_code, stripe_coupon_id, stripe_promo_id, commission_pct, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name, promo_code = excluded.promo_code,
      stripe_coupon_id = excluded.stripe_coupon_id, stripe_promo_id = excluded.stripe_promo_id,
      commission_pct = excluded.commission_pct, revoked_at = NULL
  `).run(norm, name || null, promoCode || null, stripeCouponId || null, stripePromoId || null,
         commissionPct == null ? null : commissionPct, nowTs());
  return getCollaborator(norm);
}

export function getCollaborator(email) { return db.prepare('SELECT * FROM collaborators WHERE email = ?').get(normEmail(email)); }
export function getCollaboratorByPromoId(promoId) { return promoId ? db.prepare('SELECT * FROM collaborators WHERE stripe_promo_id = ?').get(String(promoId)) : undefined; }
export function markCollaboratorRevoked(email) { db.prepare('UPDATE collaborators SET revoked_at = ? WHERE email = ?').run(nowTs(), normEmail(email)); }
export function listCollaborators() { return db.prepare('SELECT * FROM collaborators ORDER BY created_at DESC').all(); }

// Enregistre une vente attribuée (idempotent sur la session Stripe). false = déjà loggée.
export function recordSale({ promoCode, collaboratorEmail, amountCents, currency, customerEmail, sessionId }) {
  try {
    db.prepare(`
      INSERT INTO collaborator_sales (promo_code, collaborator_email, amount_cents, currency, customer_email, stripe_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(promoCode || null, collaboratorEmail || null, amountCents || 0, currency || null,
           customerEmail || null, sessionId || null, nowTs());
    return true;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return false; // vente déjà enregistrée
    throw e;
  }
}

// Récap par collaborateur : nb de ventes + total encaissé (par devise).
export function salesSummary() {
  return db.prepare(`
    SELECT collaborator_email, currency, COUNT(*) AS n, SUM(amount_cents) AS total_cents
      FROM collaborator_sales
     GROUP BY collaborator_email, currency
     ORDER BY total_cents DESC
  `).all();
}

// ══════════════════════════════════════════════════════════════
//  ESPACE COLLABORATEUR (/partner) — tables et requêtes dédiées
//  Connexion par email seul (pas de mot de passe) : si l'email correspond à
//  un collaborateur actif ou à un admin, la session s'ouvre directement.
//  - `collaborator_payouts` : commissions RÉELLEMENT versées (saisies par l'admin)
//    → le "reste à verser" affiché au collaborateur = commission due − versements
// ══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS collaborator_payouts (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    collaborator_email TEXT NOT NULL,
    amount_cents       INTEGER NOT NULL,
    note               TEXT,
    paid_at            INTEGER NOT NULL,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sales_email ON collaborator_sales(collaborator_email);
  CREATE INDEX IF NOT EXISTS idx_payouts_email ON collaborator_payouts(collaborator_email);
`);
// Champs de profil ajoutés après coup (ALTER échoue si déjà là → on ignore)
try { db.exec('ALTER TABLE collaborators ADD COLUMN handle TEXT'); } catch { /* déjà migré */ }
try { db.exec('ALTER TABLE collaborators ADD COLUMN payout_method TEXT'); } catch { /* déjà migré */ }
try { db.exec('ALTER TABLE collaborators ADD COLUMN discount_pct INTEGER'); } catch { /* déjà migré */ }
try { db.exec('ALTER TABLE collaborators ADD COLUMN last_seen_at INTEGER'); } catch { /* déjà migré */ }

// ── Profil collaborateur : champs éditables ─────────────────────
export function updateCollaboratorProfile(email, { name, handle, payoutMethod }) {
  const norm = normEmail(email);
  const c = getCollaborator(norm);
  if (!c) return null;
  db.prepare('UPDATE collaborators SET name = ?, handle = ?, payout_method = ? WHERE email = ?')
    .run(name ?? c.name ?? null, handle ?? c.handle ?? null, payoutMethod ?? c.payout_method ?? null, norm);
  return getCollaborator(norm);
}
export function setCollaboratorCommission(email, pct) {
  db.prepare('UPDATE collaborators SET commission_pct = ? WHERE email = ?').run(pct, normEmail(email));
  return getCollaborator(email);
}
export function setCollaboratorDiscount(email, pct) {
  db.prepare('UPDATE collaborators SET discount_pct = ? WHERE email = ?').run(pct, normEmail(email));
}
export function touchCollaborator(email) {
  db.prepare('UPDATE collaborators SET last_seen_at = ? WHERE email = ?').run(nowTs(), normEmail(email));
}
export function reactivateCollaborator(email) {
  db.prepare('UPDATE collaborators SET revoked_at = NULL WHERE email = ?').run(normEmail(email));
}

// ── Ventes ──────────────────────────────────────────────────────
// Toutes les ventes d'un collaborateur (les plus récentes d'abord).
export function salesForCollaborator(email) {
  return db.prepare('SELECT * FROM collaborator_sales WHERE collaborator_email = ? ORDER BY created_at DESC')
    .all(normEmail(email));
}
export function allSales() {
  return db.prepare('SELECT * FROM collaborator_sales ORDER BY created_at DESC').all();
}

// ── Versements de commission ────────────────────────────────────
export function addPayout({ email, amountCents, note, paidAt }) {
  const now = nowTs();
  db.prepare('INSERT INTO collaborator_payouts (collaborator_email, amount_cents, note, paid_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(normEmail(email), Math.round(amountCents), note || null, paidAt || now, now);
  return true;
}
export function deletePayout(id) {
  db.prepare('DELETE FROM collaborator_payouts WHERE id = ?').run(Number(id));
}
export function payoutsFor(email) {
  return db.prepare('SELECT * FROM collaborator_payouts WHERE collaborator_email = ? ORDER BY paid_at DESC')
    .all(normEmail(email));
}
export function payoutTotals() {
  return db.prepare('SELECT collaborator_email, SUM(amount_cents) AS paid_cents FROM collaborator_payouts GROUP BY collaborator_email').all();
}

// Comptes reliés à un email (sert à savoir si le collaborateur s'est déjà connecté)
export function accountSummary(email) {
  const a = qAccByEmail.get(normEmail(email));
  if (!a) return null;
  return { plan: a.plan, hasPassword: Boolean(a.password_hash), viaGoogle: Boolean(a.google_id), createdAt: a.created_at };
}

// ══════════════════════════════════════════════════════════════
//  JOURNAL DES ÉVÉNEMENTS D'ARGENT (dashboard perso /admin/revenus)
//  Une ligne par événement Stripe qui touche au revenu. Écrit par le webhook,
//  lu par le dashboard : ça donne un historique instantané (flux en direct,
//  courbes jour par jour) sans repaginer l'API Stripe à chaque affichage.
//  `stripe_event_id` UNIQUE = idempotence : Stripe rejoue les webhooks.
// ══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS revenue_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_event_id TEXT UNIQUE,
    kind            TEXT NOT NULL,   -- new_sub | trial_started | renewal | cancel | payment_failed | refund | dispute | trial_ending
    email           TEXT,
    customer_id     TEXT,
    plan            TEXT,            -- weekly | monthly | annual
    amount_cents    INTEGER,         -- encaissé sur l'événement (négatif = sortant)
    currency        TEXT,
    mrr_delta_cents INTEGER,         -- impact MRR normalisé au mois (+ à la souscription, − à la résiliation)
    promo_code      TEXT,
    detail          TEXT,            -- motif de résiliation, raison d'échec…
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revev_created ON revenue_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_revev_kind ON revenue_events(kind);
`);

// Renvoie false si l'événement était déjà enregistré (rejeu Stripe) — l'appelant
// s'en sert pour ne pas renvoyer deux fois l'email d'alerte.
export function recordRevenueEvent(e) {
  try {
    db.prepare(`INSERT INTO revenue_events
      (stripe_event_id, kind, email, customer_id, plan, amount_cents, currency, mrr_delta_cents, promo_code, detail, created_at, source, campaign, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.stripeEventId || null, e.kind, normEmail(e.email) || null, e.customerId || null, e.plan || null,
           e.amountCents ?? null, e.currency || null, e.mrrDeltaCents ?? null, e.promoCode || null,
           e.detail || null, e.createdAt || nowTs(), e.source || null, e.campaign || null, e.content || null);
    return true;
  } catch {
    return false; // contrainte UNIQUE → déjà traité
  }
}

export function listRevenueEvents(limit = 60) {
  return db.prepare('SELECT * FROM revenue_events ORDER BY created_at DESC, id DESC LIMIT ?').all(Math.min(Number(limit) || 60, 500));
}

export function revenueEventsSince(sinceTs) {
  return db.prepare('SELECT * FROM revenue_events WHERE created_at >= ? ORDER BY created_at ASC').all(Math.floor(sinceTs));
}

// ── Inscriptions (pour le taux de conversion inscrit → payant) ──
export function signupCounts(sinceTs) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM accounts').get()?.n || 0;
  const period = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?').get(Math.floor(sinceTs))?.n || 0;
  const paying = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan = 'premium'").get()?.n || 0;
  return { total, period, paying };
}

// Inscriptions jour par jour ('YYYY-MM-DD' Europe/Paris), pour superposer
// la courbe des inscriptions à celle des ventes.
export function signupsByDay(sinceTs) {
  const rows = db.prepare('SELECT created_at FROM accounts WHERE created_at >= ?').all(Math.floor(sinceTs));
  const out = {};
  for (const r of rows) {
    const d = parisDay(new Date(r.created_at * 1000));
    out[d] = (out[d] || 0) + 1;
  }
  return out;
}

// Ventes attribuées à un collaborateur sur la période (part du CA affilié).
export function affiliateSalesSince(sinceTs) {
  return db.prepare('SELECT * FROM collaborator_sales WHERE created_at >= ? ORDER BY created_at ASC').all(Math.floor(sinceTs));
}

// ══════════════════════════════════════════════════════════════
//  ACQUISITION : d'où vient chaque visiteur, et ce qu'il rapporte
//
//  Le problème que ça résout : gtag() ne suffit pas. Le navigateur intégré
//  de TikTok, les bloqueurs et iOS avalent une partie des événements côté
//  client, et surtout Google Analytics ne sait pas qui a PAYÉ. Ici tout est
//  écrit côté serveur, contre le cookie device_id signé — la même clé que
//  celle qui sert au paiement. C'est ce qui permet de dire « cette vidéo a
//  rapporté 149 € », pas juste « 300 sessions ».
//
//  · attribution   : premier et dernier contact par appareil
//  · funnel_events : chaque étape franchie (arrivée → analyse → paywall → achat)
//  · video_links   : un lien court par vidéo TikTok, et ses clics
// ══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS attribution (
    device_id       TEXT PRIMARY KEY,
    first_source    TEXT, first_medium TEXT, first_campaign TEXT, first_content TEXT,
    first_referrer  TEXT, first_landing TEXT, first_at INTEGER,
    last_source     TEXT, last_medium TEXT, last_campaign TEXT, last_content TEXT,
    last_at         INTEGER
  );
  CREATE TABLE IF NOT EXISTS funnel_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  TEXT NOT NULL,
    step       TEXT NOT NULL,     -- land | signup | analyze | paywall | checkout | paid | cancel
    detail     TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_funnel_step ON funnel_events(step, created_at);
  CREATE INDEX IF NOT EXISTS idx_funnel_device ON funnel_events(device_id);

  -- Un lien court par vidéo TikTok : taco-tac.app/v/CODE. Le code voyage en
  -- utm_content jusqu'à la vente, donc chaque euro remonte à une vidéo précise.
  CREATE TABLE IF NOT EXISTS video_links (
    code        TEXT PRIMARY KEY,      -- court, lisible : "dm3", "spicy7"
    label       TEXT,                  -- de quoi parle la vidéo
    platform    TEXT NOT NULL DEFAULT 'tiktok',
    dest        TEXT,                  -- chemin de destination (défaut : la LP)
    posted_at   INTEGER,               -- date de publication de la vidéo
    clicks      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS video_clicks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL,
    device_id  TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vclicks ON video_clicks(code, created_at);

  -- Stats saisies à la main / importées depuis TikTok Studio (l'app TikTok
  -- ayant été refusée, l'API ne les donne pas). Un relevé par date : ça permet
  -- de voir l'évolution d'une même vidéo, pas juste son dernier état.
  CREATE TABLE IF NOT EXISTS video_stats (
    code       TEXT NOT NULL,
    measured_on TEXT NOT NULL,         -- 'YYYY-MM-DD'
    views      INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (code, measured_on)
  );
`);
// L'attribution suit la vente : ces colonnes disent quelle vidéo a payé.
try { db.exec('ALTER TABLE revenue_events ADD COLUMN source TEXT'); } catch { /* déjà migré */ }
try { db.exec('ALTER TABLE revenue_events ADD COLUMN campaign TEXT'); } catch { /* déjà migré */ }
try { db.exec('ALTER TABLE revenue_events ADD COLUMN content TEXT'); } catch { /* déjà migré */ }

const clean = (v, max = 120) => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};

// Premier contact figé, dernier contact rafraîchi. Le premier contact est ce qui
// compte pour créditer une vidéo : c'est elle qui a fait entrer la personne,
// même si elle revient plus tard par un lien direct.
export function recordAttribution(deviceId, hit) {
  if (!deviceId) return;
  const now = nowTs();
  const src = clean(hit.source), med = clean(hit.medium), camp = clean(hit.campaign), cont = clean(hit.content);
  if (!src && !med && !camp && !cont && !hit.referrer) return; // visite directe sans signal : rien à écrire
  const existing = db.prepare('SELECT device_id FROM attribution WHERE device_id = ?').get(deviceId);
  if (!existing) {
    db.prepare(`INSERT INTO attribution
      (device_id, first_source, first_medium, first_campaign, first_content, first_referrer, first_landing, first_at,
       last_source, last_medium, last_campaign, last_content, last_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(deviceId, src, med, camp, cont, clean(hit.referrer, 300), clean(hit.landing, 300), now, src, med, camp, cont, now);
    return;
  }
  if (!src && !med && !camp && !cont) return; // retour direct : on ne réécrit pas le dernier contact
  db.prepare('UPDATE attribution SET last_source = ?, last_medium = ?, last_campaign = ?, last_content = ?, last_at = ? WHERE device_id = ?')
    .run(src, med, camp, cont, now, deviceId);
}

export function getAttribution(deviceId) {
  if (!deviceId) return null;
  return db.prepare('SELECT * FROM attribution WHERE device_id = ?').get(deviceId) || null;
}

// ── Entonnoir ───────────────────────────────────────────────────
// Une étape n'est comptée qu'une fois par appareil et par jour : sinon un
// visiteur qui recharge la page dix fois pèse dix fois dans le taux de passage.
export function recordFunnelStep(deviceId, step, detail = null) {
  if (!deviceId || !step) return false;
  const day = parisDay();
  const already = db.prepare(
    "SELECT 1 FROM funnel_events WHERE device_id = ? AND step = ? AND created_at >= ?"
  ).get(deviceId, step, Math.floor(new Date(day + 'T00:00:00Z').getTime() / 1000) - 7200);
  if (already) return false;
  db.prepare('INSERT INTO funnel_events (device_id, step, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(deviceId, step, clean(detail, 200), nowTs());
  return true;
}

// Entonnoir global sur la période : combien d'appareils distincts par étape.
export function funnelCounts(sinceTs) {
  const rows = db.prepare(`
    SELECT step, COUNT(DISTINCT device_id) AS n
      FROM funnel_events WHERE created_at >= ? GROUP BY step
  `).all(Math.floor(sinceTs));
  return Object.fromEntries(rows.map((r) => [r.step, r.n]));
}

// Même entonnoir, découpé par source d'acquisition : c'est là qu'on voit qu'une
// source amène du monde mais que personne ne paie.
export function funnelBySource(sinceTs) {
  return db.prepare(`
    SELECT COALESCE(a.first_source, 'direct') AS source, f.step, COUNT(DISTINCT f.device_id) AS n
      FROM funnel_events f
      LEFT JOIN attribution a ON a.device_id = f.device_id
     WHERE f.created_at >= ?
     GROUP BY source, f.step
  `).all(Math.floor(sinceTs));
}

// ── Liens courts par vidéo ──────────────────────────────────────
export function upsertVideoLink({ code, label, platform, dest, postedAt }) {
  const c = String(code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  if (!c) return null;
  const existing = db.prepare('SELECT code FROM video_links WHERE code = ?').get(c);
  if (existing) {
    db.prepare('UPDATE video_links SET label = ?, platform = ?, dest = ?, posted_at = ?, archived_at = NULL WHERE code = ?')
      .run(clean(label, 160), clean(platform) || 'tiktok', clean(dest, 200), postedAt || null, c);
  } else {
    db.prepare('INSERT INTO video_links (code, label, platform, dest, posted_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c, clean(label, 160), clean(platform) || 'tiktok', clean(dest, 200), postedAt || null, nowTs());
  }
  return getVideoLink(c);
}
export function getVideoLink(code) {
  return db.prepare('SELECT * FROM video_links WHERE code = ?').get(String(code || '').toLowerCase()) || null;
}
export function listVideoLinks() {
  return db.prepare('SELECT * FROM video_links ORDER BY COALESCE(posted_at, created_at) DESC').all();
}
export function archiveVideoLink(code) {
  db.prepare('UPDATE video_links SET archived_at = ? WHERE code = ?').run(nowTs(), String(code || '').toLowerCase());
}
export function recordVideoClick(code, deviceId) {
  const c = String(code || '').toLowerCase();
  db.prepare('UPDATE video_links SET clicks = clicks + 1 WHERE code = ?').run(c);
  db.prepare('INSERT INTO video_clicks (code, device_id, created_at) VALUES (?, ?, ?)').run(c, deviceId || null, nowTs());
}

// ── Relevés TikTok saisis à la main ─────────────────────────────
export function recordVideoStats({ code, measuredOn, views, likes, comments, shares, saves }) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return false;
  const num = (v) => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v)) || 0));
  db.prepare(`INSERT INTO video_stats (code, measured_on, views, likes, comments, shares, saves, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, measured_on) DO UPDATE SET
      views = excluded.views, likes = excluded.likes, comments = excluded.comments,
      shares = excluded.shares, saves = excluded.saves`)
    .run(c, measuredOn || parisDay(), num(views), num(likes), num(comments), num(shares), num(saves), nowTs());
  return true;
}
// Dernier relevé connu de chaque vidéo (le plus récent fait foi).
export function latestVideoStats() {
  const rows = db.prepare(`
    SELECT s.* FROM video_stats s
     WHERE s.measured_on = (SELECT MAX(measured_on) FROM video_stats WHERE code = s.code)
  `).all();
  return Object.fromEntries(rows.map((r) => [r.code, r]));
}
export function videoStatsHistory(code) {
  return db.prepare('SELECT * FROM video_stats WHERE code = ? ORDER BY measured_on ASC').all(String(code || '').toLowerCase());
}

// ── Performance par vidéo : clics → inscriptions → payants → euros ──
// Le lien entre les deux mondes : utm_content porte le code de la vidéo, donc
// on regroupe les appareils par `first_content` et on regarde qui a payé.
export function videoPerformance(sinceTs) {
  const since = Math.floor(sinceTs);
  const clicks = db.prepare('SELECT code, COUNT(*) AS n, COUNT(DISTINCT device_id) AS uniques FROM video_clicks WHERE created_at >= ? GROUP BY code').all(since);
  const signups = db.prepare(`
    SELECT a.first_content AS code, COUNT(DISTINCT f.device_id) AS n
      FROM funnel_events f JOIN attribution a ON a.device_id = f.device_id
     WHERE f.step = 'signup' AND f.created_at >= ? AND a.first_content IS NOT NULL
     GROUP BY a.first_content`).all(since);
  const sales = db.prepare(`
    SELECT content AS code, COUNT(*) AS n, SUM(amount_cents) AS cents
      FROM revenue_events
     WHERE kind IN ('new_sub','renewal') AND created_at >= ? AND content IS NOT NULL
     GROUP BY content`).all(since);
  const byCode = (rows) => Object.fromEntries(rows.map((r) => [String(r.code).toLowerCase(), r]));
  return { clicks: byCode(clicks), signups: byCode(signups), sales: byCode(sales) };
}

// Chiffre d'affaires par source d'acquisition (tous canaux confondus).
export function revenueBySource(sinceTs) {
  return db.prepare(`
    SELECT COALESCE(source, 'direct') AS source, COUNT(*) AS n, SUM(amount_cents) AS cents
      FROM revenue_events
     WHERE kind IN ('new_sub','renewal') AND created_at >= ?
     GROUP BY source ORDER BY cents DESC`).all(Math.floor(sinceTs));
}

export default db;

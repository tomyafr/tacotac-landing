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
export function getUserByEmail(email) {
  return email ? qByEmail.get(email) : undefined;
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

export default db;

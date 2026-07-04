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
export const PREMIUM_DAILY_LIMIT = 50;  // abonné : "illimité" mais garde-fou anti-script
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
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`);

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
export function effectivePlan(user) {
  if (!user) return 'free';
  if (user.plan === 'founder') return 'founder';
  if (user.plan === 'premium') {
    if (!user.plan_expires_at || user.plan_expires_at * 1000 > Date.now()) return 'premium';
    return 'free'; // abonnement expiré
  }
  return 'free';
}

export function dailyLimitFor(plan) {
  if (plan === 'founder') return FOUNDER_DAILY_LIMIT;
  if (plan === 'premium') return PREMIUM_DAILY_LIMIT;
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
export function getStatus(deviceId) {
  const user = getOrCreateUser(deviceId);
  const plan = effectivePlan(user);
  const limit = dailyLimitFor(plan);
  const used = usageToday(user.device_id);
  return {
    deviceId: user.device_id,
    plan,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    isPremium: plan === 'premium' || plan === 'founder',
  };
}

// Vérifie le quota ET consomme 1 crédit si autorisé.
// Atomique de fait : Node mono-thread + DatabaseSync synchrone => aucun entrelacement
// possible entre la lecture du compteur et son incrément.
// `ip` sert de garde-fou anti-abus pour le tier gratuit (le cookie change en
// navigation privée, pas l'IP). Les abonnés ne sont pas concernés par le plafond IP.
export function consumeQuota(deviceId, ip) {
  const user = getOrCreateUser(deviceId);
  const plan = effectivePlan(user);
  const isPremium = plan === 'premium' || plan === 'founder';
  const limit = dailyLimitFor(plan);
  const used = usageToday(user.device_id);

  const blocked = (reason) => ({
    allowed: false, reason, deviceId: user.device_id, plan, used, limit, remaining: 0, isPremium,
  });

  // Plafond par appareil (tous les plans)
  if (used >= limit) return blocked('device');

  // Plafond par IP (gratuit uniquement) : bloque le contournement navigation privée
  if (!isPremium && ip && ipUsageToday(ip) >= IP_FREE_DAILY_LIMIT) return blocked('ip');

  qUpsertUsage.run(user.device_id, parisDay());
  if (!isPremium && ip) qUpsertIpUsage.run(ip, parisDay());

  const newUsed = used + 1;
  return { allowed: true, deviceId: user.device_id, plan, used: newUsed, limit,
           remaining: Math.max(0, limit - newUsed), isPremium };
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
export function activatePremium({ deviceId, email, customerId, subscriptionId, expiresAt }) {
  getOrCreateUser(deviceId); // garantit la ligne
  qSetPremium.run(email || null, customerId || null, subscriptionId || null, expiresAt || null, deviceId);
  return qGetUser.get(deviceId);
}

// Met à jour un abonnement existant (renouvellement, changement de statut) via le customer Stripe.
// Renvoie false si aucun user n'est rattaché à ce customer (ex : device_id perdu → à relier via email).
export function syncSubscription({ customerId, subscriptionId, status, expiresAt }) {
  const active = status === 'active' || status === 'trialing' || status === 'past_due';
  const plan = active ? 'premium' : 'free';
  const res = qSyncByCustomer.run(plan, subscriptionId || null, active ? (expiresAt || null) : null, customerId);
  return res.changes > 0;
}

// Repasse en gratuit quand l'abonnement est annulé/supprimé.
export function deactivatePremium(customerId) {
  const res = qDowngradeCustomer.run(customerId);
  return res.changes > 0;
}

export default db;

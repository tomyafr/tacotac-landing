// ══════════════════════════════════════════════════════════════════════
//  TACOTAC — gestion des collaborateurs / affiliés (outil en ligne de commande)
//
//  Un collaborateur = un créateur qui fait des vidéos pour Tacotac. Il a l'accès
//  premium complet (statut distinct, révocable) SANS être un client payant, donc
//  il ne pollue pas tes métriques de revenu. Chaque vente via son code promo lui
//  est rattachée pour calculer sa commission.
//
//  ┌─ COMMANDES ─────────────────────────────────────────────────────────┐
//  │  node collaborator.js add <email> ["Nom"] [CODE]                     │
//  │      → crée/active le collaborateur + génère son code promo Stripe   │
//  │        (CODE optionnel : sinon généré depuis le nom, ex: LEO)        │
//  │                                                                      │
//  │  node collaborator.js revoke <email>                                 │
//  │      → retire l'accès (repasse en gratuit) + désactive son code      │
//  │                                                                      │
//  │  node collaborator.js list                                           │
//  │      → liste tous les collaborateurs et leur statut                  │
//  │                                                                      │
//  │  node collaborator.js sales                                          │
//  │      → récap des ventes + commission due par collaborateur           │
//  └──────────────────────────────────────────────────────────────────────┘
//
//  À lancer sur le VPS depuis /var/www/tacotac/tacotac-app (accès SSH = sécurité).
//  Réglages (via .env, sinon valeurs par défaut ci-dessous) :
//    COLLAB_COMMISSION_PCT       = % reversé au collaborateur   (défaut 20)
//    COLLAB_AUDIENCE_DISCOUNT_PCT= -% pour ses followers         (défaut 10)
// ══════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import Stripe from 'stripe';
import {
  setCollaboratorPlan, revokeCollaboratorPlan, upsertCollaborator, getCollaborator,
  markCollaboratorRevoked, listCollaborators, salesSummary,
} from './db.js';

const COMMISSION_PCT = Number(process.env.COLLAB_COMMISSION_PCT || 20);
const AUDIENCE_DISCOUNT_PCT = Math.max(1, Math.min(100, Number(process.env.COLLAB_AUDIENCE_DISCOUNT_PCT || 10)));

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function die(msg) { console.error('❌ ' + msg); process.exit(1); }
function eur(cents) { return (cents / 100).toFixed(2) + '€'; }

// Dérive un code promo lisible à partir du nom (ou de l'email), en MAJUSCULES sans accents.
function slugCode(nameOrEmail) {
  const base = String(nameOrEmail).split('@')[0].split(/\s+/)[0];
  return base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12) || 'COLLAB';
}

// Garantit un code promo unique côté Stripe (ajoute un suffixe si déjà pris).
async function uniquePromoCodeString(desired) {
  let code = desired;
  for (let i = 0; i < 20; i++) {
    const existing = await stripe.promotionCodes.list({ code, limit: 1 });
    if (!existing.data.length) return code;
    code = desired + Math.floor(10 + Math.random() * 89); // desired + 2 chiffres
  }
  return desired + Date.now().toString().slice(-4);
}

async function cmdAdd(email, name, wantedCode) {
  if (!EMAIL_RE.test(email)) die(`Email invalide : ${email}`);
  if (!stripe) die('STRIPE_SECRET_KEY manquant dans .env — impossible de générer le code promo.');

  // 1) Code promo Stripe (coupon -X% pour ses followers + promotion_code lisible)
  const codeStr = await uniquePromoCodeString(slugCode(wantedCode || name || email));
  const coupon = await stripe.coupons.create({
    percent_off: AUDIENCE_DISCOUNT_PCT,
    duration: 'once', // -X% sur la 1re facture du follower (change en 'forever' si tu veux un rabais permanent)
    name: `Collab ${name || email} (-${AUDIENCE_DISCOUNT_PCT}%)`,
  });
  const promo = await stripe.promotionCodes.create({
    coupon: coupon.id,
    code: codeStr,
    metadata: { collaborator: email.toLowerCase() },
  });

  // 2) Statut collaborateur (accès complet immédiat) + mapping en base
  setCollaboratorPlan(email);
  upsertCollaborator({
    email, name,
    promoCode: promo.code,
    stripeCouponId: coupon.id,
    stripePromoId: promo.id,
    commissionPct: COMMISSION_PCT,
  });

  console.log('\n✅ Collaborateur activé\n');
  console.log(`   Email        : ${email.toLowerCase()}`);
  if (name) console.log(`   Nom          : ${name}`);
  console.log(`   Accès        : premium complet (statut collaborateur, hors métriques revenu)`);
  console.log(`   Code promo   : ${promo.code}   (-${AUDIENCE_DISCOUNT_PCT}% pour ses followers)`);
  console.log(`   Commission   : ${COMMISSION_PCT}% des ventes via ce code`);
  console.log(`\n   → Il se connecte sur l'app avec CET email (Google ou mot de passe) et il a tout.`);
  console.log(`   → Il partage le code « ${promo.code} » dans ses vidéos ; les ventes te remontent via « node collaborator.js sales ».\n`);
}

async function cmdRevoke(email) {
  if (!EMAIL_RE.test(email)) die(`Email invalide : ${email}`);
  const existed = revokeCollaboratorPlan(email);
  const collab = getCollaborator(email);
  if (collab) markCollaboratorRevoked(email);
  // Désactive le code promo côté Stripe (les ventes déjà loggées restent en base)
  if (stripe && collab?.stripe_promo_id) {
    try { await stripe.promotionCodes.update(collab.stripe_promo_id, { active: false }); }
    catch (e) { console.error('   (code promo Stripe non désactivé : ' + e.message + ')'); }
  }
  if (!existed && !collab) die(`Aucun collaborateur trouvé pour ${email}.`);
  console.log(`\n✅ ${email.toLowerCase()} révoqué — repassé en gratuit, code promo désactivé.`);
  console.log(`   (son historique de ventes est conservé pour le calcul de commission)\n`);
}

function cmdList() {
  const rows = listCollaborators();
  if (!rows.length) return console.log('\nAucun collaborateur pour l’instant.\n');
  console.log('\n📋 Collaborateurs\n');
  for (const c of rows) {
    const statut = c.revoked_at ? '🔴 révoqué' : '🟢 actif';
    console.log(`   ${statut}  ${c.email}${c.name ? ' (' + c.name + ')' : ''}`);
    console.log(`            code ${c.promo_code || '—'} · commission ${c.commission_pct ?? '?'}%`);
  }
  console.log('');
}

function cmdSales() {
  const rows = salesSummary();
  if (!rows.length) return console.log('\nAucune vente attribuée pour l’instant.\n');
  const commByEmail = Object.fromEntries(listCollaborators().map((c) => [c.email, c.commission_pct ?? COMMISSION_PCT]));
  console.log('\n💰 Ventes par collaborateur\n');
  let grandTotal = 0, grandComm = 0;
  for (const r of rows) {
    const pct = commByEmail[r.collaborator_email] ?? COMMISSION_PCT;
    const commission = Math.round(r.total_cents * pct / 100);
    grandTotal += r.total_cents; grandComm += commission;
    console.log(`   ${r.collaborator_email}`);
    console.log(`      ${r.n} vente(s) · encaissé ${eur(r.total_cents)} ${r.currency?.toUpperCase() || ''} · commission (${pct}%) = ${eur(commission)}`);
  }
  console.log(`\n   ─────────────────────────────`);
  console.log(`   TOTAL encaissé : ${eur(grandTotal)} · commissions à verser : ${eur(grandComm)}\n`);
}

// ── Dispatch ──
const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'add') await cmdAdd(args[0], args[1], args[2]);
  else if (cmd === 'revoke') await cmdRevoke(args[0]);
  else if (cmd === 'list') cmdList();
  else if (cmd === 'sales') cmdSales();
  else {
    console.log(`
Usage :
  node collaborator.js add <email> ["Nom"] [CODE]   ajouter/activer un collaborateur
  node collaborator.js revoke <email>               retirer l'accès + désactiver son code
  node collaborator.js list                         lister les collaborateurs
  node collaborator.js sales                        récap ventes + commissions
`);
  }
} catch (e) {
  die(e.message);
}
process.exit(0);

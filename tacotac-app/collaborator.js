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
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://taco-tac.app';
// Même endpoint que server.js (le projet Apps Script "Tacotac Waitlist"). Hardcodé côté serveur,
// donc pas dans .env — on le reprend ici pour pousser le roster vers l'onglet Collaborateurs.
const WAITLIST_WEBHOOK = process.env.WAITLIST_WEBHOOK || 'https://script.google.com/macros/s/AKfycbzuCip2KWPlPw7kudrsvP2DuZ94-W6yw6aJ7c_HiSFZysXaPfsvG57uq6lhDsDpGYudtw/exec';

// apiVersion figée, identique au serveur : le défaut du SDK vise une version
// bleeding-edge où la forme de promotion_codes change (param `coupon` rejeté sinon).
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function die(msg) { console.error('❌ ' + msg); process.exit(1); }
function eur(cents) { return (cents / 100).toFixed(2) + '€'; }

// ── Email de bienvenue collaborateur (même charte que les mails transactionnels) ──
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || key.includes('a_remplir')) { console.warn('[email] RESEND_API_KEY absente → non envoyé'); return false; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.GIFT_FROM_EMAIL || 'Tacotac <onboarding@resend.dev>', to, subject, html }),
  });
  if (!r.ok) { console.error('[email] resend', r.status, await r.text().catch(() => '')); return false; }
  return true;
}

function collabWelcomeHtml({ name, code, discount, commission }) {
  const hi = name ? name.split(/\s+/)[0] : 'toi';
  const inner = `
    <h1 style="font-size:23px;margin:0 0 10px;text-align:center;color:#fff;">Bienvenue dans l'équipe 🦊</h1>
    <p style="color:#B5ABA0;font-size:15px;line-height:1.65;margin:0 0 20px;">Salut ${hi}, c'est officiel : ton <b style="color:#fff;">compte collaborateur Tacotac</b> est ouvert. Tu as accès à <b style="color:#fff;">tout le Premium gratuitement</b> — les 6 tons, l'analyse illimitée, tout.</p>
    <div style="background:#0d0d0d;border:1.5px dashed rgba(255,122,69,.5);border-radius:14px;padding:18px;text-align:center;margin-bottom:20px;">
      <div style="color:#8A7F70;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Ton code promo (il marche déjà)</div>
      <div style="font-size:27px;font-weight:800;letter-spacing:2px;color:#FF7A45;">${code}</div>
      <div style="color:#8A7F70;font-size:12.5px;margin-top:8px;">${discount ? `-${discount}% pour ta communauté` : 'remise pour ta communauté'}</div>
    </div>
    <p style="color:#B5ABA0;font-size:14.5px;line-height:1.65;margin:0 0 6px;"><b style="color:#fff;">Pour commencer :</b> connecte-toi sur l'app avec <b style="color:#fff;">cet email</b> (Google ou mot de passe) et tout se débloque.</p>
    <p style="color:#B5ABA0;font-size:14.5px;line-height:1.65;margin:0;">Chaque vente faite avec ton code t'est comptée${commission ? ` (${commission}% pour toi)` : ''}. Balance-le dans tes vidéos et fais-toi plaisir 🔥</p>`;
  return `<div style="background:#0b0b0b;padding:32px 14px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;">
    <div style="text-align:center;padding-bottom:20px;">
      <a href="${PUBLIC_URL}" style="text-decoration:none;">
        <img src="${PUBLIC_URL}/assets/icon-192.png" width="64" height="64" alt="Tacotac" style="border-radius:18px;border:0;display:inline-block;">
        <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-.3px;margin-top:10px;">Tacotac</div>
      </a>
    </div>
    <div style="background:#161616;border:1px solid #262626;border-radius:20px;padding:32px 28px;color:#F4EEE2;">
      ${inner}
      <a href="${PUBLIC_URL}/app" style="display:block;text-align:center;background:#FF5C00;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:16px;border-radius:13px;margin-top:26px;">Ouvrir Tacotac →</a>
    </div>
    <p style="color:#6e6a66;font-size:11.5px;text-align:center;margin:18px 0 0;line-height:1.7;">Tacotac · ton coach dating IA<br>Tu reçois cet email car ton compte collaborateur vient d'être créé sur <a href="${PUBLIC_URL}" style="color:#8a8580;">taco-tac.app</a></p>
  </div></div>`;
}

async function cmdWelcome(email) {
  const c = getCollaborator(email);
  if (!c) die(`Aucun collaborateur pour ${email} — fais d'abord "add".`);
  let discount = null;
  if (stripe && c.stripe_coupon_id) {
    try { discount = (await stripe.coupons.retrieve(c.stripe_coupon_id)).percent_off; } catch { /* pas grave */ }
  }
  const html = collabWelcomeHtml({ name: c.name, code: c.promo_code, discount, commission: c.commission_pct });
  const ok = await sendEmail({ to: c.email, subject: 'Ton accès collaborateur Tacotac est ouvert 🦊', html });
  console.log(ok ? `\n✅ Email de bienvenue envoyé à ${c.email}\n` : `\n❌ Email non envoyé (RESEND_API_KEY configurée ?)\n`);
}

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

// Pousse la liste complète des collaborateurs vers l'onglet "Collaborateurs" du Sheet.
// (Nb ventes / CA / commission due sont calculés par des formules côté Sheet.)
async function pushRosterToSheet() {
  const webhook = WAITLIST_WEBHOOK;
  if (!webhook) { console.warn('   (webhook absent → onglet Collaborateurs non mis à jour)'); return false; }
  const rows = listCollaborators();
  const out = [];
  for (const c of rows) {
    let discount = null;
    if (stripe && c.stripe_coupon_id) {
      try { discount = (await stripe.coupons.retrieve(c.stripe_coupon_id)).percent_off; } catch { /* pas grave */ }
    }
    out.push({
      name: c.name || '',
      email: c.email,
      code: c.promo_code || '',
      discountPct: discount,
      commissionPct: c.commission_pct,
      status: c.revoked_at ? 'Révoqué' : 'Actif',
      createdAt: c.created_at ? new Date(c.created_at).toLocaleDateString('fr-FR') : '',
    });
  }
  try {
    const r = await fetch(`${webhook}?source=collab-roster&data=${encodeURIComponent(JSON.stringify(out))}`);
    const j = await r.json().catch(() => ({}));
    console.log(`   Onglet Collaborateurs : ${j.message || 'mis à jour'}`);
    return true;
  } catch (e) { console.error('   (sync Sheet échoué : ' + e?.message + ')'); return false; }
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
  console.log(`   → Il partage le code « ${promo.code} » dans ses vidéos ; les ventes te remontent via « node collaborator.js sales ».`);
  await pushRosterToSheet();
  console.log('');
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
  console.log(`   (son historique de ventes est conservé pour le calcul de commission)`);
  await pushRosterToSheet();
  console.log('');
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
  else if (cmd === 'welcome') await cmdWelcome(args[0]);
  else if (cmd === 'sync') { console.log('\n🔄 Sync onglet Collaborateurs…'); await pushRosterToSheet(); console.log(''); }
  else {
    console.log(`
Usage :
  node collaborator.js add <email> ["Nom"] [CODE]   ajouter/activer un collaborateur
  node collaborator.js welcome <email>              (ré)envoyer l'email de bienvenue
  node collaborator.js revoke <email>               retirer l'accès + désactiver son code
  node collaborator.js list                         lister les collaborateurs
  node collaborator.js sales                        récap ventes + commissions
  node collaborator.js sync                         rafraîchir l'onglet Collaborateurs du Sheet
`);
  }
} catch (e) {
  die(e.message);
}
process.exit(0);

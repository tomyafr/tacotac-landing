// ══════════════════════════════════════════════════════════════════════
//  TACOTAC — création des comptes de l'espace collaborateur
//
//  Reprend la liste de l'onglet « Collaborateurs » du Google Sheet et garantit
//  que CHAQUE collaborateur a bien, côté serveur :
//    · une ligne dans `collaborators` (code promo, commission, remise)
//    · un compte `accounts` en statut collaborator (Premium offert)
//  → il peut se connecter tout de suite sur /partner avec son email.
//
//  Le script est IDEMPOTENT : relançable sans risque, il ne casse rien
//  d'existant et ne recrée jamais un code promo Stripe déjà en place.
//
//    node seed-collaborators.js            # crée/vérifie (aucun email envoyé)
//    node seed-collaborators.js --invite   # + envoie à chacun son lien d'accès
// ══════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import {
  getCollaborator, upsertCollaborator, setCollaboratorPlan, setCollaboratorDiscount,
  createPartnerToken, listCollaborators, accountSummary,
} from './db.js';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://taco-tac.app';
const INVITE = process.argv.includes('--invite');

// ── Roster (onglet « Collaborateurs » du Sheet TACOTAC) ─────────
// Pour ajouter quelqu'un : soit ici, soit — bien plus simple — via la console
// admin de /partner, qui crée aussi le code promo Stripe automatiquement.
const ROSTER = [
  { name: 'AMELYA', email: 'solene.durand2012@gmail.com', code: 'AMELYA10', commissionPct: 20, discountPct: 10 },
  { name: 'ANOMY',  email: 'ethan.marcel1@icloud.com',    code: 'ANOMY25',  commissionPct: 25, discountPct: 20 },
];

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || key.includes('a_remplir')) { console.warn('   ⚠ RESEND_API_KEY absente → email non envoyé'); return false; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.GIFT_FROM_EMAIL || 'Tacotac <onboarding@resend.dev>', to, subject, html }),
  });
  if (!r.ok) { console.error('   ❌ resend', r.status, await r.text().catch(() => '')); return false; }
  return true;
}

const inviteHtml = (name, link) => `<div style="background:#0b0b0b;padding:32px 14px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;">
    <div style="text-align:center;padding-bottom:20px;">
      <img src="${PUBLIC_URL}/assets/icon-192.png" width="64" height="64" alt="Tacotac" style="border-radius:18px;border:0;">
      <div style="color:#ffffff;font-size:20px;font-weight:800;margin-top:10px;">Tacotac</div>
    </div>
    <div style="background:#161616;border:1px solid #262626;border-radius:20px;padding:32px 28px;color:#F4EEE2;">
      <h1 style="font-size:23px;margin:0 0 10px;text-align:center;color:#fff;">Ton espace collaborateur est ouvert 🦊</h1>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.65;margin:0 0 8px;">Salut ${name || 'toi'}, tu peux maintenant suivre <b style="color:#fff;">en direct</b> le nombre d'abonnements pris avec ton code, le chiffre d'affaires généré et ta commission.</p>
      <p style="color:#8A7F70;font-size:13px;line-height:1.6;margin:0;">Le bouton ci-dessous te connecte directement. Ensuite, crée ton mot de passe dans « Mon profil » pour revenir quand tu veux.</p>
      <a href="${link}" style="display:block;text-align:center;background:#FF5C00;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:16px;border-radius:13px;margin-top:26px;">Ouvrir mon espace →</a>
    </div>
    <p style="color:#6e6a66;font-size:11.5px;text-align:center;margin:18px 0 0;">Lien personnel — ne le partage pas.</p>
  </div></div>`;

console.log('\n🦊 Espace collaborateur — vérification du roster\n');
for (const c of ROSTER) {
  const email = c.email.toLowerCase();
  const existing = getCollaborator(email);
  // On ne réécrit PAS les ids Stripe : s'ils existent déjà, on les conserve tels quels.
  upsertCollaborator({
    email,
    name: c.name,
    promoCode: existing?.promo_code || c.code,
    stripeCouponId: existing?.stripe_coupon_id || null,
    stripePromoId: existing?.stripe_promo_id || null,
    commissionPct: existing?.commission_pct ?? c.commissionPct,
  });
  setCollaboratorDiscount(email, existing?.discount_pct ?? c.discountPct);
  setCollaboratorPlan(email); // crée le compte s'il n'existe pas + Premium offert

  const acc = accountSummary(email);
  const how = acc?.viaGoogle ? 'Google' : acc?.hasPassword ? 'mot de passe' : 'jamais connecté';
  console.log(`   ${existing ? '✓ à jour ' : '＋ créé  '} ${email}  · code ${existing?.promo_code || c.code} · accès : ${how}`);

  if (INVITE) {
    const link = `${PUBLIC_URL}/partner/auth?token=${createPartnerToken(email, 60 * 24 * 7)}`;
    const sent = await sendEmail({ to: email, subject: 'Ton espace collaborateur Tacotac est ouvert 🦊', html: inviteHtml(c.name, link) });
    console.log(sent ? '            ✉️  lien envoyé' : `            🔗 ${link}`);
  }
}

console.log(`\n${listCollaborators().length} collaborateur(s) en base.`);
console.log(`Espace : ${PUBLIC_URL}/partner\n`);
process.exit(0);

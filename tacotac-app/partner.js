// ══════════════════════════════════════════════════════════════════════
//  TACOTAC — ESPACE COLLABORATEUR (routes /partner + /api/partner/*)
//
//  Portail privé, non lié depuis le site : un collaborateur s'y connecte avec
//  SON email (celui de son compte Tacotac) et voit en temps réel :
//    · combien de personnes ont pris un abonnement avec SON code promo
//    · le CA généré, sa commission, ce qui lui a déjà été versé, le reste dû
//    · des graphiques (évolution, cumul, répartition par formule) + filtres
//
//  L'admin (PARTNER_ADMIN_EMAILS) voit en plus la console : tous les
//  collaborateurs, création/révocation, réglage des commissions, versements.
//
//  Sécurité : réutilise EXACTEMENT la session de l'app (cookie signé httpOnly).
//  Aucun accès n'est possible sans être dans la table `collaborators` (ou admin).
// ══════════════════════════════════════════════════════════════════════

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import {
  getCollaborator, listCollaborators, upsertCollaborator, setCollaboratorPlan,
  revokeCollaboratorPlan, markCollaboratorRevoked, reactivateCollaborator,
  salesForCollaborator, allSales, addPayout, deletePayout, payoutsFor, payoutTotals,
  createPartnerToken, consumePartnerToken, setAccountPassword, updateCollaboratorProfile,
  setCollaboratorCommission, setCollaboratorDiscount, touchCollaborator, accountSummary,
  getAccountByEmail,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DEFAULT_COMMISSION = Number(process.env.COLLAB_COMMISSION_PCT || 20);
const DEFAULT_DISCOUNT = Math.max(1, Math.min(100, Number(process.env.COLLAB_AUDIENCE_DISCOUNT_PCT || 10)));

// Emails admin de l'espace (séparés par des virgules dans .env). Défaut : le fondateur.
const ADMIN_EMAILS = new Set(
  String(process.env.PARTNER_ADMIN_EMAILS || 'tomathieuia@gmail.com')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);

const norm = (e) => String(e || '').trim().toLowerCase();
const nowTs = () => Math.floor(Date.now() / 1000);

/**
 * Crée le routeur de l'espace collaborateur.
 * `deps` fournit les briques déjà présentes dans server.js pour ne rien dupliquer :
 *   openSession / destroySession / attachAccount / hashPassword / verifyPassword
 *   sessionCookieName / stripe / publicUrl / sendMail
 */
export function createPartnerRouter(deps) {
  const {
    openSession, destroySession, attachAccount, hashPassword, verifyPassword,
    sessionCookieName, stripe, publicUrl, sendMail,
  } = deps;

  const router = express.Router();

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
  const linkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });

  // ── Qui est connecté ? ───────────────────────────────────────
  // Renvoie { email, isAdmin, collab } ou null. Un admin sans ligne
  // `collaborators` reste admin (il n'a pas de code promo, c'est normal).
  function whoami(req) {
    attachAccount(req);
    const email = norm(req.account?.email);
    if (!email) return null;
    const isAdmin = ADMIN_EMAILS.has(email);
    const collab = getCollaborator(email) || null;
    if (!isAdmin && (!collab || collab.revoked_at)) return null;
    return { email, isAdmin, collab };
  }

  function requirePartner(req, res, next) {
    const me = whoami(req);
    if (!me) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    req.partner = me;
    next();
  }
  function requireAdminPartner(req, res, next) {
    const me = whoami(req);
    if (!me?.isAdmin) return res.status(403).json({ ok: false, error: 'forbidden' });
    req.partner = me;
    next();
  }

  // ════════════════════ PAGES ════════════════════
  const page = (req, res) => res.sendFile(path.join(__dirname, 'views', 'partner.html'));
  router.get('/partner', page);
  router.get('/collab', page);

  // Lien magique : /partner/auth?token=… → ouvre la session puis renvoie sur le dashboard
  router.get('/partner/auth', (req, res) => {
    const email = consumePartnerToken(req.query.token);
    if (!email) return res.redirect('/partner?err=link');
    const collab = getCollaborator(email);
    if (!collab && !ADMIN_EMAILS.has(email)) return res.redirect('/partner?err=access');
    if (collab?.revoked_at) return res.redirect('/partner?err=revoked');
    const acc = getAccountByEmail(email) || setCollaboratorPlan(email); // crée le compte si absent
    openSession(res, acc.id);
    res.redirect('/partner?welcome=1');
  });

  // ════════════════════ AUTH ════════════════════

  // État de session (le front décide : écran de login ou dashboard)
  router.get('/api/partner/session', (req, res) => {
    const me = whoami(req);
    if (!me) return res.json({ ok: false });
    touchCollaborator(me.email);
    const acc = accountSummary(me.email);
    res.json({
      ok: true,
      email: me.email,
      isAdmin: me.isAdmin,
      isCollaborator: Boolean(me.collab),
      name: me.collab?.name || null,
      hasPassword: Boolean(acc?.hasPassword),
      viaGoogle: Boolean(acc?.viaGoogle),
    });
  });

  router.post('/api/partner/login', loginLimiter, (req, res) => {
    const email = norm(req.body?.email);
    const password = String(req.body?.password || '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'Entre un email valide.' });

    const collab = getCollaborator(email);
    const isAdmin = ADMIN_EMAILS.has(email);
    // Message volontairement identique pour un email inconnu ET un non-collaborateur :
    // impossible de deviner qui fait partie du programme depuis l'extérieur.
    if (!isAdmin && !collab) return res.status(403).json({ ok: false, error: "Cet email ne fait pas partie de l'espace collaborateur." });
    if (collab?.revoked_at && !isAdmin) return res.status(403).json({ ok: false, error: 'Ton accès collaborateur a été clôturé.' });

    const acc = getAccountByEmail(email);
    if (!acc?.password_hash) {
      return res.status(409).json({ ok: false, error: 'no_password',
        message: "Tu n'as pas encore de mot de passe. Reçois ton lien de connexion par email." });
    }
    if (!verifyPassword(password, acc.password_hash)) return res.status(401).json({ ok: false, error: 'Mot de passe incorrect.' });
    openSession(res, acc.id);
    touchCollaborator(email);
    res.json({ ok: true });
  });

  // Lien magique par email (1re connexion / mot de passe oublié)
  router.post('/api/partner/magic', linkLimiter, async (req, res) => {
    const email = norm(req.body?.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'Entre un email valide.' });
    const collab = getCollaborator(email);
    const isAdmin = ADMIN_EMAILS.has(email);
    // Réponse identique dans tous les cas : pas d'énumération des collaborateurs.
    if ((collab && !collab.revoked_at) || isAdmin) {
      const token = createPartnerToken(email);
      const link = `${publicUrl}/partner/auth?token=${token}`;
      await sendMail({
        to: email,
        subject: 'Ton accès à ton espace collaborateur Tacotac 🦊',
        html: magicLinkHtml({ link, name: collab?.name, publicUrl }),
      }).catch(() => {});
    }
    res.json({ ok: true });
  });

  router.post('/api/partner/logout', (req, res) => {
    destroySession(req.signedCookies?.[sessionCookieName]);
    res.clearCookie(sessionCookieName);
    res.json({ ok: true });
  });

  // Définir / changer son mot de passe (une fois connecté par lien magique ou Google)
  router.post('/api/partner/password', requirePartner, (req, res) => {
    const pw = String(req.body?.password || '');
    if (pw.length < 8) return res.status(400).json({ ok: false, error: '8 caractères minimum.' });
    setAccountPassword(req.partner.email, hashPassword(pw));
    res.json({ ok: true });
  });

  // Profil éditable par le collaborateur (nom affiché, pseudo réseaux, moyen de paiement)
  router.post('/api/partner/profile', requirePartner, (req, res) => {
    if (!req.partner.collab) return res.status(400).json({ ok: false, error: 'no_collab' });
    const clean = (v, n) => (v == null ? undefined : String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, n));
    updateCollaboratorProfile(req.partner.email, {
      name: clean(req.body?.name, 60),
      handle: clean(req.body?.handle, 60),
      payoutMethod: clean(req.body?.payoutMethod, 120),
    });
    res.json({ ok: true });
  });

  // ════════════════════ DASHBOARD ════════════════════

  router.get('/api/partner/dashboard', requirePartner, (req, res) => {
    // Un admin peut inspecter le tableau de bord d'un collaborateur (?as=email)
    const asEmail = norm(req.query.as);
    const targetEmail = req.partner.isAdmin && asEmail ? asEmail : req.partner.email;
    const collab = getCollaborator(targetEmail);
    if (!collab) {
      // Admin sans ligne collaborateur : il n'a pas de dashboard perso, il a la console.
      return res.json({ ok: true, adminOnly: true, isAdmin: req.partner.isAdmin, email: req.partner.email });
    }
    res.json({
      ok: true,
      isAdmin: req.partner.isAdmin,
      viewingOther: targetEmail !== req.partner.email,
      ...buildDashboard(collab, { publicUrl }),
    });
  });

  // Export CSV des ventes (le collaborateur peut vérifier ligne à ligne)
  router.get('/api/partner/export.csv', requirePartner, (req, res) => {
    const asEmail = norm(req.query.as);
    const email = req.partner.isAdmin && asEmail ? asEmail : req.partner.email;
    const collab = getCollaborator(email);
    if (!collab) return res.status(404).send('no data');
    const pct = collab.commission_pct ?? DEFAULT_COMMISSION;
    const lines = ['date;code;client;montant_eur;commission_eur'];
    for (const s of salesForCollaborator(email)) {
      lines.push([
        new Date(s.created_at * 1000).toISOString().slice(0, 10),
        s.promo_code || '',
        maskEmail(s.customer_email),
        ((s.amount_cents || 0) / 100).toFixed(2),
        ((s.amount_cents || 0) * pct / 100 / 100).toFixed(2),
      ].join(';'));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="tacotac-ventes-${email.split('@')[0]}.csv"`);
    res.send('﻿' + lines.join('\n'));
  });

  // ════════════════════ CONSOLE ADMIN ════════════════════

  router.get('/api/partner/admin/overview', requireAdminPartner, (req, res) => {
    const collabs = listCollaborators();
    const paid = Object.fromEntries(payoutTotals().map((p) => [p.collaborator_email, p.paid_cents || 0]));
    const rows = collabs.map((c) => {
      const sales = salesForCollaborator(c.email);
      const pct = c.commission_pct ?? DEFAULT_COMMISSION;
      const revenue = sales.reduce((n, s) => n + (s.amount_cents || 0), 0);
      const commission = Math.round(revenue * pct / 100);
      const acc = accountSummary(c.email);
      return {
        email: c.email,
        name: c.name || '',
        handle: c.handle || '',
        promoCode: c.promo_code || '',
        commissionPct: pct,
        discountPct: c.discount_pct ?? null,
        status: c.revoked_at ? 'revoked' : 'active',
        createdAt: c.created_at,
        lastSeenAt: c.last_seen_at || null,
        payoutMethod: c.payout_method || '',
        connected: Boolean(acc && (acc.hasPassword || acc.viaGoogle)),
        sales: sales.length,
        revenueCents: revenue,
        commissionCents: commission,
        paidCents: paid[c.email] || 0,
        dueCents: Math.max(0, commission - (paid[c.email] || 0)),
        lastSaleAt: sales[0]?.created_at || null,
      };
    });
    const totals = rows.reduce((t, r) => ({
      sales: t.sales + r.sales,
      revenueCents: t.revenueCents + r.revenueCents,
      commissionCents: t.commissionCents + r.commissionCents,
      paidCents: t.paidCents + r.paidCents,
      dueCents: t.dueCents + r.dueCents,
    }), { sales: 0, revenueCents: 0, commissionCents: 0, paidCents: 0, dueCents: 0 });
    // Série globale (toutes ventes confondues) pour le graphique de la console
    const series = dailySeries(allSales(), 90);
    res.json({ ok: true, collaborators: rows, totals, series, defaults: { commissionPct: DEFAULT_COMMISSION, discountPct: DEFAULT_DISCOUNT } });
  });

  // Créer un collaborateur : code promo Stripe + compte + statut + email de bienvenue
  router.post('/api/partner/admin/collaborators', requireAdminPartner, async (req, res) => {
    const email = norm(req.body?.email);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const wantedCode = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    const commissionPct = clampPct(req.body?.commissionPct, DEFAULT_COMMISSION);
    const discountPct = clampPct(req.body?.discountPct, DEFAULT_DISCOUNT);
    const sendWelcome = req.body?.sendWelcome !== false;

    if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'Email invalide.' });
    const existing = getCollaborator(email);
    if (existing && !existing.revoked_at) return res.status(409).json({ ok: false, error: 'Ce collaborateur existe déjà.' });
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe non configuré côté serveur (STRIPE_SECRET_KEY).' });

    try {
      const codeStr = await uniquePromoCode(stripe, wantedCode || slugCode(name || email));
      const coupon = await stripe.coupons.create({
        percent_off: discountPct,
        duration: 'once',
        name: `Collab ${name || email} (-${discountPct}%)`,
      });
      const promo = await stripe.promotionCodes.create({
        coupon: coupon.id, code: codeStr, metadata: { collaborator: email },
      });
      setCollaboratorPlan(email);
      upsertCollaborator({
        email, name, promoCode: promo.code,
        stripeCouponId: coupon.id, stripePromoId: promo.id, commissionPct,
      });
      setCollaboratorDiscount(email, discountPct);

      let emailSent = false;
      if (sendWelcome) {
        const token = createPartnerToken(email, 60 * 24 * 7); // 7 jours pour la 1re connexion
        emailSent = await sendMail({
          to: email,
          subject: "Bienvenue dans l'équipe Tacotac 🦊 — ton espace collaborateur est ouvert",
          html: welcomeHtml({ name, code: promo.code, discountPct, commissionPct, publicUrl,
                              link: `${publicUrl}/partner/auth?token=${token}` }),
        }).catch(() => false);
      }
      res.json({ ok: true, code: promo.code, emailSent });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || 'Création impossible.' });
    }
  });

  // Renvoyer un lien d'accès (1re connexion oubliée, changement de téléphone…)
  router.post('/api/partner/admin/invite', requireAdminPartner, async (req, res) => {
    const email = norm(req.body?.email);
    const c = getCollaborator(email);
    if (!c) return res.status(404).json({ ok: false, error: 'Collaborateur inconnu.' });
    const token = createPartnerToken(email, 60 * 24 * 7);
    const sent = await sendMail({
      to: email,
      subject: 'Ton lien de connexion à ton espace collaborateur Tacotac',
      html: magicLinkHtml({ link: `${publicUrl}/partner/auth?token=${token}`, name: c.name, publicUrl }),
    }).catch(() => false);
    res.json({ ok: true, emailSent: Boolean(sent), link: `${publicUrl}/partner/auth?token=${token}` });
  });

  router.post('/api/partner/admin/revoke', requireAdminPartner, async (req, res) => {
    const email = norm(req.body?.email);
    const c = getCollaborator(email);
    if (!c) return res.status(404).json({ ok: false, error: 'Collaborateur inconnu.' });
    revokeCollaboratorPlan(email);
    markCollaboratorRevoked(email);
    if (stripe && c.stripe_promo_id) {
      try { await stripe.promotionCodes.update(c.stripe_promo_id, { active: false }); } catch { /* non bloquant */ }
    }
    res.json({ ok: true });
  });

  router.post('/api/partner/admin/reactivate', requireAdminPartner, async (req, res) => {
    const email = norm(req.body?.email);
    const c = getCollaborator(email);
    if (!c) return res.status(404).json({ ok: false, error: 'Collaborateur inconnu.' });
    setCollaboratorPlan(email);
    reactivateCollaborator(email);
    if (stripe && c.stripe_promo_id) {
      try { await stripe.promotionCodes.update(c.stripe_promo_id, { active: true }); } catch { /* non bloquant */ }
    }
    res.json({ ok: true });
  });

  router.post('/api/partner/admin/update', requireAdminPartner, (req, res) => {
    const email = norm(req.body?.email);
    if (!getCollaborator(email)) return res.status(404).json({ ok: false, error: 'Collaborateur inconnu.' });
    if (req.body?.commissionPct != null) setCollaboratorCommission(email, clampPct(req.body.commissionPct, DEFAULT_COMMISSION));
    if (req.body?.name != null || req.body?.handle != null) {
      updateCollaboratorProfile(email, {
        name: req.body?.name == null ? undefined : String(req.body.name).trim().slice(0, 60),
        handle: req.body?.handle == null ? undefined : String(req.body.handle).trim().slice(0, 60),
      });
    }
    res.json({ ok: true });
  });

  // Versements de commission (l'admin note ce qu'il a payé → le collab voit son "reste dû")
  router.post('/api/partner/admin/payout', requireAdminPartner, (req, res) => {
    const email = norm(req.body?.email);
    const amount = Number(req.body?.amountEur);
    if (!getCollaborator(email)) return res.status(404).json({ ok: false, error: 'Collaborateur inconnu.' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'Montant invalide.' });
    addPayout({ email, amountCents: Math.round(amount * 100), note: String(req.body?.note || '').slice(0, 120) });
    res.json({ ok: true });
  });

  router.post('/api/partner/admin/payout/delete', requireAdminPartner, (req, res) => {
    deletePayout(req.body?.id);
    res.json({ ok: true });
  });

  return router;
}

// ══════════════════════ CALCULS ══════════════════════

// Masque l'email d'un client : on ne divulgue jamais l'identité complète d'un acheteur
// au collaborateur (RGPD + bon sens), mais il voit assez pour reconnaître une vente.
function maskEmail(email) {
  const [u, d] = String(email || '').split('@');
  if (!u || !d) return '—';
  const head = u.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(2, Math.min(6, u.length - 2)))}@${d}`;
}

// Nom de formule déduit du montant payé (on ne stocke pas le price_id sur la vente).
function formulaFromCents(c) {
  if (c <= 0) return 'Offert';
  if (c < 800) return 'Hebdo';
  if (c < 2500) return 'Mensuel';
  return 'Annuel';
}

const parisDayKey = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(ts * 1000));

// Série journalière sur `days` jours (toujours dense : les jours sans vente valent 0,
// sinon les graphiques mentent sur le rythme réel).
function dailySeries(sales, days) {
  const byDay = new Map();
  for (const s of sales) {
    const k = parisDayKey(s.created_at);
    const cur = byDay.get(k) || { revenue: 0, count: 0 };
    cur.revenue += s.amount_cents || 0; cur.count += 1;
    byDay.set(k, cur);
  }
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const k = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
    const v = byDay.get(k) || { revenue: 0, count: 0 };
    out.push({ day: k, revenueCents: v.revenue, count: v.count });
  }
  return out;
}

// Construit tout ce que le tableau de bord affiche. Les filtres de période sont
// appliqués CÔTÉ CLIENT sur ces données brutes : navigation instantanée, zéro requête.
function buildDashboard(collab, { publicUrl }) {
  const pct = collab.commission_pct ?? DEFAULT_COMMISSION;
  const sales = salesForCollaborator(collab.email);
  const payouts = payoutsFor(collab.email);
  const paidCents = payouts.reduce((n, p) => n + (p.amount_cents || 0), 0);
  const revenueCents = sales.reduce((n, s) => n + (s.amount_cents || 0), 0);
  const commissionCents = Math.round(revenueCents * pct / 100);

  return {
    profile: {
      email: collab.email,
      name: collab.name || '',
      handle: collab.handle || '',
      promoCode: collab.promo_code || '',
      commissionPct: pct,
      discountPct: collab.discount_pct ?? DEFAULT_DISCOUNT,
      status: collab.revoked_at ? 'revoked' : 'active',
      createdAt: collab.created_at,
      payoutMethod: collab.payout_method || '',
      shareLink: collab.promo_code ? `${publicUrl}/?code=${encodeURIComponent(collab.promo_code)}` : publicUrl,
    },
    totals: {
      sales: sales.length,
      revenueCents,
      commissionCents,
      paidCents,
      dueCents: Math.max(0, commissionCents - paidCents),
      avgCents: sales.length ? Math.round(revenueCents / sales.length) : 0,
    },
    // Ventes brutes : le front filtre/agrège (date en secondes UTC)
    sales: sales.map((s) => ({
      id: s.id,
      at: s.created_at,
      amountCents: s.amount_cents || 0,
      commissionCents: Math.round((s.amount_cents || 0) * pct / 100),
      customer: maskEmail(s.customer_email),
      formula: formulaFromCents(s.amount_cents || 0),
      currency: (s.currency || 'eur').toUpperCase(),
    })),
    payouts: payouts.map((p) => ({ id: p.id, at: p.paid_at, amountCents: p.amount_cents, note: p.note || '' })),
  };
}

function clampPct(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function slugCode(nameOrEmail) {
  const base = String(nameOrEmail).split('@')[0].split(/\s+/)[0];
  return base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12) || 'COLLAB';
}

// Garantit un code promo libre côté Stripe (ajoute 2 chiffres si déjà pris).
async function uniquePromoCode(stripe, desired) {
  let code = desired;
  for (let i = 0; i < 20; i++) {
    const existing = await stripe.promotionCodes.list({ code, limit: 1 });
    if (!existing.data.length) return code;
    code = desired + Math.floor(10 + Math.random() * 89);
  }
  return desired + Date.now().toString().slice(-4);
}

// ══════════════════════ EMAILS ══════════════════════

function shell(inner, publicUrl, cta = { href: `${publicUrl}/partner`, label: 'Ouvrir mon espace →' }) {
  return `<div style="background:#0b0b0b;padding:32px 14px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;">
    <div style="text-align:center;padding-bottom:20px;">
      <a href="${publicUrl}" style="text-decoration:none;">
        <img src="${publicUrl}/assets/icon-192.png" width="64" height="64" alt="Tacotac" style="border-radius:18px;border:0;display:inline-block;">
        <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-.3px;margin-top:10px;">Tacotac</div>
      </a>
    </div>
    <div style="background:#161616;border:1px solid #262626;border-radius:20px;padding:32px 28px;color:#F4EEE2;">
      ${inner}
      <a href="${cta.href}" style="display:block;text-align:center;background:#FF5C00;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:16px;border-radius:13px;margin-top:26px;">${cta.label}</a>
    </div>
    <p style="color:#6e6a66;font-size:11.5px;text-align:center;margin:18px 0 0;line-height:1.7;">Tacotac · espace collaborateur<br>Lien personnel — ne le partage pas.</p>
  </div></div>`;
}

function magicLinkHtml({ link, name, publicUrl }) {
  const hi = name ? String(name).split(/\s+/)[0] : 'toi';
  return shell(`
    <h1 style="font-size:23px;margin:0 0 10px;text-align:center;color:#fff;">Ton lien de connexion 🔑</h1>
    <p style="color:#B5ABA0;font-size:15px;line-height:1.65;margin:0 0 8px;">Salut ${hi}, clique sur le bouton pour ouvrir <b style="color:#fff;">ton espace collaborateur</b> : tes ventes, tes commissions, tes stats en direct.</p>
    <p style="color:#8A7F70;font-size:13px;line-height:1.6;margin:0;">Ce lien est valable une seule fois. Une fois dedans, tu pourras créer un mot de passe pour te reconnecter quand tu veux.</p>`,
    publicUrl, { href: link, label: 'Ouvrir mon espace →' });
}

function welcomeHtml({ name, code, discountPct, commissionPct, publicUrl, link }) {
  const hi = name ? String(name).split(/\s+/)[0] : 'toi';
  return shell(`
    <h1 style="font-size:23px;margin:0 0 10px;text-align:center;color:#fff;">Bienvenue dans l'équipe 🦊</h1>
    <p style="color:#B5ABA0;font-size:15px;line-height:1.65;margin:0 0 20px;">Salut ${hi}, ton <b style="color:#fff;">compte collaborateur Tacotac</b> est ouvert : Premium offert à vie, et un espace perso pour suivre tes gains en temps réel.</p>
    <div style="background:#0d0d0d;border:1.5px dashed rgba(255,122,69,.5);border-radius:14px;padding:18px;text-align:center;margin-bottom:20px;">
      <div style="color:#8A7F70;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Ton code promo</div>
      <div style="font-size:27px;font-weight:800;letter-spacing:2px;color:#FF7A45;">${code}</div>
      <div style="color:#8A7F70;font-size:12.5px;margin-top:8px;">-${discountPct}% pour ta communauté · ${commissionPct}% pour toi</div>
    </div>
    <p style="color:#B5ABA0;font-size:14.5px;line-height:1.65;margin:0;">Chaque abonnement pris avec ton code apparaît dans ton espace, avec le détail de ta commission. Le lien ci-dessous te connecte directement.</p>`,
    publicUrl, { href: link, label: 'Ouvrir mon espace collaborateur →' });
}

export default createPartnerRouter;

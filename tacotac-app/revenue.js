// ══════════════════════════════════════════════════════════════════════
//  TACOTAC — MON DASHBOARD REVENUS (/admin/revenus)
//
//  L'espace collaborateur montre ce que gagnent LES AUTRES. Ici c'est ton
//  argent à toi : MRR, abonnés, essais, churn, encaissé net après frais
//  Stripe, impayés, prochain virement. Le Stripe Dashboard rapatrié dans
//  Tacotac, avec en plus ce que Stripe ne sait pas (inscriptions, part
//  affiliée, motifs de résiliation).
//
//  Deux sources, complémentaires :
//    · Stripe en direct (API) → l'état d'aujourd'hui, toujours juste
//    · table `revenue_events` (remplie par le webhook) → l'historique
//      jour par jour et le flux en direct, sans repaginer l'API
//
//  Accès : cookie ADMIN_TOKEN, comme /admin/tiktok.
// ══════════════════════════════════════════════════════════════════════

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRevenueEvents, revenueEventsSince, signupCounts, signupsByDay,
         affiliateSalesSince, cancellationStats, listCancellationFeedback, parisDay } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DAY = 86400;
const nowTs = () => Math.floor(Date.now() / 1000);

// ── Normalisation du prix en MRR ────────────────────────────────
// Un abonnement hebdo et un annuel ne se comparent pas tels quels : on ramène
// tout au mois (52 semaines / 12 mois, 1 an / 12) pour que le MRR ait un sens.
function priceToMonthlyCents(price, quantity = 1) {
  const r = price?.recurring;
  if (!r) return 0;
  const per = (price.unit_amount || 0) * quantity;
  const n = r.interval_count || 1;
  switch (r.interval) {
    case 'year':  return per / (12 * n);
    case 'week':  return (per * 52) / (12 * n);
    case 'day':   return (per * 365) / (12 * n);
    default:      return per / n; // month
  }
}

// Remise en cours sur l'abonnement (codes promo collaborateurs = -10% récurrent
// ou une fois). On ne déduit que les remises qui durent : une remise `once` est
// déjà passée dans l'encaissé, elle ne pèse pas sur le MRR futur.
function discountFactor(sub) {
  const list = sub?.discounts?.length ? sub.discounts : (sub?.discount ? [sub.discount] : []);
  let factor = 1;
  for (const d of list) {
    const coupon = (typeof d === 'object' ? d : null)?.coupon;
    if (!coupon || coupon.duration === 'once') continue;
    if (coupon.percent_off) factor *= (1 - coupon.percent_off / 100);
  }
  return factor;
}

function subMonthlyCents(sub) {
  let cents = 0;
  for (const item of sub.items?.data || []) cents += priceToMonthlyCents(item.price, item.quantity || 1);
  return Math.round(cents * discountFactor(sub));
}

// Libellé de formule : d'abord par id de prix (.env), sinon déduit de l'intervalle.
function planKeyFactory(prices) {
  const byId = new Map(Object.entries(prices).filter(([, v]) => v).map(([k, v]) => [v, k]));
  return (sub) => {
    const price = sub.items?.data?.[0]?.price;
    if (!price) return 'inconnu';
    return byId.get(price.id) || ({ week: 'weekly', month: 'monthly', year: 'annual' }[price.recurring?.interval] || 'inconnu');
  };
}

// Toutes les pages d'une liste Stripe (les listes plafonnent à 100 par appel).
async function all(listPromise, max = 2000) {
  return listPromise.autoPagingToArray({ limit: max });
}

// ── Le calcul complet ───────────────────────────────────────────
async function computeSnapshot(stripe, prices, days) {
  const now = nowTs();
  const since = now - days * DAY;
  const planKey = planKeyFactory(prices);

  // `status: 'all'` : il faut les annulés pour calculer le churn et la
  // conversion d'essai. `expand` évite un appel par abonnement.
  const [subs, balance, payouts, openInvoices, txns] = await Promise.all([
    all(stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.discounts'] })),
    stripe.balance.retrieve().catch(() => null),
    stripe.payouts.list({ limit: 5 }).then((r) => r.data).catch(() => []),
    all(stripe.invoices.list({ status: 'open', limit: 100 }), 200).catch(() => []),
    all(stripe.balanceTransactions.list({ created: { gte: since }, limit: 100 }), 3000).catch(() => []),
  ]);

  // ── Abonnements en cours ──────────────────────────────────────
  // `active` + `past_due` uniquement, pour matcher exactement la définition du
  // MRR de Stripe (support.stripe.com : "active and past due subscriptions").
  // `unpaid` (tentatives de paiement épuisées) reste compté dans `atRisk` —
  // il pèse plus lourd comme signal d'alerte que comme argent réellement acquis.
  const live = subs.filter((s) => ['active', 'past_due'].includes(s.status));
  const trialing = subs.filter((s) => s.status === 'trialing');
  const atRisk = subs.filter((s) => ['past_due', 'unpaid'].includes(s.status));
  const cancelAtEnd = live.filter((s) => s.cancel_at_period_end);

  const mrrCents = live.reduce((n, s) => n + subMonthlyCents(s), 0);
  const trialMrrCents = trialing.reduce((n, s) => n + subMonthlyCents(s), 0);

  const byPlan = {};
  for (const s of live) {
    const k = planKey(s);
    byPlan[k] = byPlan[k] || { key: k, count: 0, mrrCents: 0 };
    byPlan[k].count++;
    byPlan[k].mrrCents += subMonthlyCents(s);
  }

  // ── Mouvements de la période (depuis Stripe, pas depuis le journal :
  //    ça reste juste même sur les ventes antérieures à cette page) ──
  const newSubs = subs.filter((s) => s.created >= since);
  const churned = subs.filter((s) => s.canceled_at && s.canceled_at >= since);
  const newMrrCents = newSubs.filter((s) => s.status !== 'trialing').reduce((n, s) => n + subMonthlyCents(s), 0);
  const lostMrrCents = churned.reduce((n, s) => n + subMonthlyCents(s), 0);

  // Churn mensuel = résiliations sur la période ramenées au mois, rapportées
  // à la base d'abonnés de début de période.
  const startBase = live.length + churned.length;
  const churnRate = startBase > 0 ? (churned.length / startBase) * (30 / days) : 0;

  // ── Conversion d'essai ────────────────────────────────────────
  // Un essai est "converti" dès que l'abonnement a dépassé la date de fin
  // d'essai sans être annulé avant. Les essais en cours ne comptent pas.
  const trials = subs.filter((s) => s.trial_start);
  const decided = trials.filter((s) => s.status !== 'trialing');
  const converted = decided.filter((s) => ['active', 'past_due', 'unpaid'].includes(s.status)
    || (s.canceled_at && s.trial_end && s.canceled_at > s.trial_end));
  const trialConversion = decided.length ? converted.length / decided.length : null;

  // ── Argent réellement encaissé (net des frais Stripe) ─────────
  // balance_transactions = la vérité comptable : ce qui entre, ce que Stripe
  // prélève, ce qui ressort en remboursements et litiges.
  let grossCents = 0, feeCents = 0, netCents = 0, refundCents = 0, disputeCents = 0;
  const netByDay = {};
  for (const t of txns) {
    if (t.type === 'payout' || t.type === 'payout_cancel' || t.type === 'payout_failure') continue;
    if (['charge', 'payment'].includes(t.type)) grossCents += t.amount;
    if (['refund', 'payment_refund', 'payment_failure_refund'].includes(t.type)) refundCents += -t.amount;
    if (t.type === 'adjustment') disputeCents += -t.amount;
    feeCents += t.fee || 0;
    netCents += t.net;
    const d = parisDay(new Date(t.created * 1000));
    netByDay[d] = (netByDay[d] || 0) + t.net;
  }

  // ── Renouvellements attendus sous 7 jours ─────────────────────
  const in7 = now + 7 * DAY;
  const renewals = live
    .filter((s) => !s.cancel_at_period_end)
    .map((s) => ({ at: s.items?.data?.[0]?.current_period_end || s.current_period_end, sub: s }))
    .filter((r) => r.at && r.at <= in7);
  const renewalCents = renewals.reduce((n, r) => {
    const item = r.sub.items?.data?.[0];
    return n + Math.round((item?.price?.unit_amount || 0) * (item?.quantity || 1) * discountFactor(r.sub));
  }, 0);

  // ── Ce que Stripe ne sait pas : local ─────────────────────────
  const signups = signupCounts(since);
  const affSales = affiliateSalesSince(since);
  const affCents = affSales.reduce((n, s) => n + (s.amount_cents || 0), 0);
  const events = revenueEventsSince(since);

  // Série jour par jour : nouveaux abos, résiliations, encaissé net, inscriptions.
  const signupDays = signupsByDay(since);
  const series = [];
  for (let t = now - (days - 1) * DAY; t <= now; t += DAY) {
    const d = parisDay(new Date(t * 1000));
    series.push({
      day: d,
      netCents: Math.round(netByDay[d] || 0),
      signups: signupDays[d] || 0,
      newSubs: newSubs.filter((s) => parisDay(new Date(s.created * 1000)) === d).length,
      churned: churned.filter((s) => parisDay(new Date(s.canceled_at * 1000)) === d).length,
    });
  }

  const activeCount = live.length;
  const arpuCents = activeCount ? Math.round(mrrCents / activeCount) : 0;
  // LTV = ce qu'un client rapporte par mois ÷ la probabilité qu'il parte chaque mois.
  const ltvCents = churnRate > 0 ? Math.round(arpuCents / churnRate) : null;

  return {
    generatedAt: now,
    days,
    currency: (live[0]?.items?.data?.[0]?.price?.currency || balance?.available?.[0]?.currency || 'eur').toUpperCase(),
    mrrCents,
    arrCents: mrrCents * 12,
    arpuCents,
    ltvCents,
    activeCount,
    trialCount: trialing.length,
    trialMrrCents,
    atRiskCount: atRisk.length,
    cancelAtEndCount: cancelAtEnd.length,
    byPlan: Object.values(byPlan).sort((a, b) => b.mrrCents - a.mrrCents),
    newSubCount: newSubs.length,
    newMrrCents,
    churnedCount: churned.length,
    lostMrrCents,
    churnRate,
    trialConversion,
    trialDecided: decided.length,
    grossCents, feeCents, netCents, refundCents, disputeCents,
    openInvoiceCount: openInvoices.length,
    openInvoiceCents: openInvoices.reduce((n, i) => n + (i.amount_due || 0), 0),
    renewalCount: renewals.length,
    renewalCents,
    balanceAvailableCents: (balance?.available || []).reduce((n, b) => n + b.amount, 0),
    balancePendingCents: (balance?.pending || []).reduce((n, b) => n + b.amount, 0),
    nextPayout: payouts.find((p) => ['pending', 'in_transit'].includes(p.status)) || payouts[0] || null,
    signups,
    signupToPaid: signups.total ? signups.paying / signups.total : null,
    affiliateSaleCount: affSales.length,
    affiliateCents: affCents,
    affiliateShare: grossCents > 0 ? affCents / grossCents : null,
    eventCount: events.length,
    series,
    cancelReasons: cancellationStats(),
    recentCancellations: listCancellationFeedback(8),
    feed: listRevenueEvents(40),
  };
}

export function createRevenueRouter({ stripe, requireAdmin, prices }) {
  const router = express.Router();

  // Cache court : une page ouverte qui s'auto-rafraîchit ne doit pas
  // repaginer tout Stripe toutes les 30 s.
  const cache = new Map();
  const TTL_MS = 60_000;

  router.get('/admin/revenus', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'admin-revenue.html'));
  });

  router.get('/admin/revenus/data', requireAdmin, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe non configuré (STRIPE_SECRET_KEY absente).' });
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const hit = cache.get(days);
    if (hit && Date.now() - hit.at < TTL_MS && req.query.fresh !== '1') return res.json(hit.data);
    try {
      const data = await computeSnapshot(stripe, prices, days);
      cache.set(days, { at: Date.now(), data });
      res.json(data);
    } catch (e) {
      console.error('[revenus] calcul:', e?.message);
      res.status(500).json({ error: e?.message || 'Erreur de calcul.' });
    }
  });

  return router;
}

export { computeSnapshot };

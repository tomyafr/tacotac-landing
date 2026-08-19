// ══════════════════════════════════════════════════════════════════════
//  TACOTAC — ACQUISITION (/admin/acquisition)
//
//  Répond à une seule question, la seule qui compte pour décider quoi
//  tourner ensuite : QUELLE VIDÉO RAPPORTE DE L'ARGENT ?
//
//  La chaîne : un lien court par vidéo en bio TikTok (/v/CODE) → le clic est
//  compté → la redirection injecte utm_content=CODE → l'attribution se colle
//  au cookie device_id → ce même device_id part chez Stripe en
//  client_reference_id → au paiement, l'euro remonte jusqu'à la vidéo.
//
//  Trois sources affichées côte à côte :
//    · TikTok (vues/likes) — saisis à la main, l'app TikTok ayant été refusée
//    · GA4 (audience, sources) — lu en direct si le compte de service est là
//    · maison (clics → inscriptions → euros) — la seule qui connaît l'argent
// ══════════════════════════════════════════════════════════════════════

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listVideoLinks, upsertVideoLink, archiveVideoLink, recordVideoStats,
  latestVideoStats, videoStatsHistory, videoPerformance, revenueBySource,
  funnelCounts, funnelBySource,
} from './db.js';
import { realtime, overview, ga4Status, ga4Ready } from './ga4.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400;

// Étapes dans l'ordre où on les franchit : sert à dessiner l'entonnoir et à
// calculer les taux de passage d'une marche à la suivante.
const STEPS = [
  { key: 'land', label: 'Arrivés sur le site' },
  { key: 'signup', label: 'Compte créé' },
  { key: 'analyze', label: 'Ont analysé' },
  { key: 'paywall', label: 'Ont vu le paywall' },
  { key: 'checkout', label: 'Ont ouvert le paiement' },
  { key: 'paid', label: 'Ont payé' },
];

function buildFunnel(counts) {
  let previous = null;
  return STEPS.map((s) => {
    const n = counts[s.key] || 0;
    const rate = previous == null ? null : (previous > 0 ? n / previous : 0);
    previous = n;
    return { ...s, n, rate };
  });
}

// Le tableau central : une ligne par vidéo, de la vue TikTok à l'euro encaissé.
function buildVideoTable(sinceTs) {
  const perf = videoPerformance(sinceTs);
  const stats = latestVideoStats();
  return listVideoLinks().map((link) => {
    const s = stats[link.code] || {};
    const clicks = perf.clicks[link.code]?.n || 0;
    const uniques = perf.clicks[link.code]?.uniques || 0;
    const signups = perf.signups[link.code]?.n || 0;
    const sales = perf.sales[link.code]?.n || 0;
    const cents = perf.sales[link.code]?.cents || 0;
    const views = s.views || 0;
    return {
      code: link.code, label: link.label, platform: link.platform,
      postedAt: link.posted_at, archived: Boolean(link.archived_at),
      totalClicks: link.clicks,
      views, likes: s.likes || 0, comments: s.comments || 0, shares: s.shares || 0,
      measuredOn: s.measured_on || null,
      clicks, uniques, signups, sales, cents,
      // Les trois taux qui font arbitrer : est-ce que la vidéo plaît (like),
      // est-ce qu'elle donne envie de cliquer (clic), est-ce qu'elle rapporte.
      likeRate: views ? (s.likes || 0) / views : null,
      clickRate: views ? clicks / views : null,
      signupRate: clicks ? signups / clicks : null,
      payRate: clicks ? sales / clicks : null,
      centsPerKView: views ? Math.round((cents / views) * 1000) : null,
    };
  });
}

// Évolution du taux de like dans le temps : c'est ce qui distingue « TikTok me
// montre moins » (vues qui chutent, taux stable) de « mes vidéos plaisent
// moins » (vues stables, taux qui chute). Deux problèmes opposés.
function buildEngagementTrend() {
  const links = listVideoLinks().filter((l) => l.posted_at);
  return links
    .map((l) => {
      const hist = videoStatsHistory(l.code);
      const last = hist[hist.length - 1];
      if (!last || !last.views) return null;
      return {
        code: l.code, label: l.label, postedAt: l.posted_at,
        views: last.views, likes: last.likes || 0,
        likeRate: (last.likes || 0) / last.views,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.postedAt - b.postedAt);
}

export function createAcquisitionRouter({ requireAdmin, publicUrl }) {
  const router = express.Router();

  router.get('/admin/acquisition', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'admin-acquisition.html'));
  });

  router.get('/admin/acquisition/data', requireAdmin, async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = Math.floor(Date.now() / 1000) - days * DAY;

    // GA4 est optionnel : s'il n'est pas configuré ou s'il tombe, la page doit
    // continuer d'afficher les chiffres maison, qui sont les plus importants.
    let ga = null, gaError = null;
    if (ga4Ready) {
      try {
        const [rt, ov] = await Promise.all([realtime(), overview(days)]);
        ga = { realtime: rt, overview: ov };
      } catch (e) {
        gaError = e.message;
      }
    }

    // L'entonnoir par source, remis à plat : { source: { step: n } }
    const bySourceRows = funnelBySource(since);
    const sourceFunnel = {};
    for (const r of bySourceRows) {
      sourceFunnel[r.source] = sourceFunnel[r.source] || {};
      sourceFunnel[r.source][r.step] = r.n;
    }

    res.json({
      generatedAt: Math.floor(Date.now() / 1000),
      days,
      publicUrl,
      videos: buildVideoTable(since),
      engagement: buildEngagementTrend(),
      funnel: buildFunnel(funnelCounts(since)),
      sourceFunnel,
      revenueBySource: revenueBySource(since),
      ga, gaError, gaStatus: ga4Status(),
    });
  });

  // ── Gestion des liens vidéo ──────────────────────────────────
  router.post('/admin/acquisition/link', requireAdmin, (req, res) => {
    const { code, label, platform, dest, postedAt } = req.body || {};
    const link = upsertVideoLink({
      code, label, platform, dest,
      postedAt: postedAt ? Math.floor(new Date(postedAt).getTime() / 1000) : null,
    });
    if (!link) return res.status(400).json({ error: 'Code invalide (lettres, chiffres, - et _ seulement).' });
    res.json({ ok: true, link, url: `${publicUrl}/v/${link.code}` });
  });

  router.post('/admin/acquisition/link/archive', requireAdmin, (req, res) => {
    archiveVideoLink(req.body?.code);
    res.json({ ok: true });
  });

  // ── Relevés TikTok ───────────────────────────────────────────
  // Saisie ligne à ligne, ou collage en masse depuis TikTok Studio :
  //   code  vues  likes  commentaires  partages
  // séparés par des tabulations ou des points-virgules. Le format tolère les
  // espaces insécables et les séparateurs de milliers (« 12 400 », « 12,4K »).
  router.post('/admin/acquisition/stats', requireAdmin, (req, res) => {
    const { rows, measuredOn } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Aucune ligne reçue.' });
    let saved = 0;
    for (const r of rows) {
      if (r?.code && recordVideoStats({ ...r, measuredOn: r.measuredOn || measuredOn })) saved++;
    }
    res.json({ ok: true, saved });
  });

  router.get('/admin/acquisition/history', requireAdmin, (req, res) => {
    res.json({ history: videoStatsHistory(req.query.code) });
  });

  return router;
}

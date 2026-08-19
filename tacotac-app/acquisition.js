// ══════════════════════════════════════════════════════════════════════
//  TACOTAC — ACQUISITION (/admin/acquisition)
//
//  Ce qui se passe à partir de la landing page : combien de monde arrive,
//  jusqu'où ils vont dans l'entonnoir (inscription → analyse → paywall →
//  paiement), et l'audience en direct via Google Analytics.
//
//  Tout est mesuré côté serveur contre le cookie device_id signé — GA compte
//  des sessions, mais ne sait pas qui a payé. `revenueBySource` reste
//  branché sur les paramètres utm_* génériques : si un lien externe en pose
//  un jour (une pub, un partenariat), le chiffre d'affaires par source
//  s'alimente tout seul, sans rien à changer ici.
// ══════════════════════════════════════════════════════════════════════

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { revenueBySource, funnelCounts, funnelBySource } from './db.js';
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
      funnel: buildFunnel(funnelCounts(since)),
      sourceFunnel,
      revenueBySource: revenueBySource(since),
      ga, gaError, gaStatus: ga4Status(),
    });
  });

  return router;
}

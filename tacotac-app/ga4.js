// ══════════════════════════════════════════════════════════════════════
//  TACOTAC — LECTURE DE GOOGLE ANALYTICS 4 CÔTÉ SERVEUR
//
//  Le gtag() du navigateur ENVOIE des données à Google. Ce module les
//  RELIT, depuis le VPS, pour les afficher dans l'espace admin : audience
//  en direct, sources de trafic, pages d'entrée, appareils, pays.
//
//  Authentification : compte de service Google. On signe un JWT avec sa clé
//  privée (RS256), on l'échange contre un jeton d'accès valable 1 h, et on
//  appelle l'API Data v1beta. Tout est fait avec `node:crypto` — aucune
//  dépendance npm ajoutée, donc rien de plus à maintenir ni à auditer.
//
//  Ce que GA sait faire ici : le haut de l'entonnoir (combien de monde, d'où).
//  Ce qu'il ne sait pas : qui a payé. Ça, c'est le tracking maison
//  (attribution + revenue_events). Les deux sont complémentaires, et la page
//  /admin/acquisition les affiche côte à côte.
// ══════════════════════════════════════════════════════════════════════

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://analyticsdata.googleapis.com/v1beta';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Le compte de service vient soit d'un fichier JSON (GA4_CREDENTIALS_FILE),
// soit du JSON collé directement dans la variable d'env (pratique en PaaS).
function loadCredentials() {
  const raw = process.env.GA4_CREDENTIALS_JSON
    || (process.env.GA4_CREDENTIALS_FILE ? readFileSync(process.env.GA4_CREDENTIALS_FILE, 'utf8') : null);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (!c.client_email || !c.private_key) throw new Error('client_email ou private_key manquant');
    return c;
  } catch (e) {
    console.error('[ga4] identifiants illisibles:', e.message);
    return null;
  }
}

const creds = loadCredentials();
const PROPERTY = String(process.env.GA4_PROPERTY_ID || '').replace(/\D/g, '');
export const ga4Ready = Boolean(creds && PROPERTY);

// Jeton gardé en mémoire jusqu'à 1 min avant expiration : on ne redemande pas
// un jeton à Google à chaque rafraîchissement de la page.
let token = null;
async function accessToken() {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(creds.private_key))}`;

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google a refusé le jeton : ${j.error_description || j.error || r.status}`);
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function call(method, body) {
  const t = await accessToken();
  const r = await fetch(`${API}/properties/${PROPERTY}:${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `GA4 ${method} a répondu ${r.status}`);
  return j;
}

// Les réponses GA4 sont des tableaux de tableaux ; on les remet à plat en
// objets nommés, sinon tout le reste du code manipule des indices opaques.
function rows(res) {
  const dims = (res.dimensionHeaders || []).map((h) => h.name);
  const mets = (res.metricHeaders || []).map((h) => h.name);
  return (res.rows || []).map((row) => {
    const o = {};
    dims.forEach((d, i) => { o[d] = row.dimensionValues?.[i]?.value ?? null; });
    mets.forEach((m, i) => { o[m] = Number(row.metricValues?.[i]?.value ?? 0); });
    return o;
  });
}

const dim = (names) => names.map((name) => ({ name }));
const met = (names) => names.map((name) => ({ name }));

/** Qui est sur le site à l'instant même (30 dernières minutes). */
export async function realtime() {
  const [total, bySource, byPage, byCountry] = await Promise.all([
    call('runRealtimeReport', { metrics: met(['activeUsers']) }),
    call('runRealtimeReport', { dimensions: dim(['unifiedScreenName']), metrics: met(['activeUsers']), limit: 8 }),
    call('runRealtimeReport', { dimensions: dim(['unifiedScreenName']), metrics: met(['screenPageViews']), limit: 8 }),
    call('runRealtimeReport', { dimensions: dim(['country']), metrics: met(['activeUsers']), limit: 6 }),
  ]);
  return {
    activeUsers: rows(total)[0]?.activeUsers || 0,
    screens: rows(bySource),
    pages: rows(byPage),
    countries: rows(byCountry),
  };
}

/** L'historique sur N jours : audience, sources, pages d'entrée, appareils. */
export async function overview(days = 30) {
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'today' }];
  const [totals, byDay, bySource, byPage, byDevice, events] = await Promise.all([
    call('runReport', { dateRanges, metrics: met(['activeUsers', 'sessions', 'screenPageViews', 'averageSessionDuration', 'bounceRate']) }),
    call('runReport', { dateRanges, dimensions: dim(['date']), metrics: met(['activeUsers', 'sessions']), orderBys: [{ dimension: { dimensionName: 'date' } }] }),
    call('runReport', { dateRanges, dimensions: dim(['sessionSource', 'sessionMedium']), metrics: met(['sessions', 'activeUsers']), limit: 12, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] }),
    call('runReport', { dateRanges, dimensions: dim(['landingPage']), metrics: met(['sessions']), limit: 10, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] }),
    call('runReport', { dateRanges, dimensions: dim(['deviceCategory']), metrics: met(['sessions']), limit: 5 }),
    call('runReport', { dateRanges, dimensions: dim(['eventName']), metrics: met(['eventCount']), limit: 15, orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }] }),
  ]);
  const t = rows(totals)[0] || {};
  return {
    activeUsers: t.activeUsers || 0,
    sessions: t.sessions || 0,
    pageViews: t.screenPageViews || 0,
    avgSessionSec: Math.round(t.averageSessionDuration || 0),
    bounceRate: t.bounceRate ?? null,
    byDay: rows(byDay).map((r) => ({ day: `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`, users: r.activeUsers, sessions: r.sessions })),
    bySource: rows(bySource),
    byPage: rows(byPage),
    byDevice: rows(byDevice),
    events: rows(events),
  };
}

/** Diagnostic : dit précisément ce qui manque, plutôt qu'un échec muet. */
export function ga4Status() {
  if (!creds && !PROPERTY) return { ready: false, why: 'GA4_PROPERTY_ID et les identifiants du compte de service sont absents.' };
  if (!creds) return { ready: false, why: 'Identifiants du compte de service absents (GA4_CREDENTIALS_FILE ou GA4_CREDENTIALS_JSON).' };
  if (!PROPERTY) return { ready: false, why: 'GA4_PROPERTY_ID absent (l’ID numérique, pas le G-XXXXXXX).' };
  return { ready: true, property: PROPERTY, serviceAccount: creds.client_email };
}

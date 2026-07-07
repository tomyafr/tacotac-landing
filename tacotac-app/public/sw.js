// ══════════════════════════════════════════════════════════════
//  TACOTAC — service worker
//  Rôle : rendre l'app installable (PWA) + un minimum d'offline.
//  Stratégie : réseau d'abord pour les pages (toujours fraîches,
//  cache en secours si hors-ligne), cache d'abord pour les assets.
//  Les appels /api/* ne sont JAMAIS interceptés (quota, paiement…).
// ══════════════════════════════════════════════════════════════

const CACHE = 'tacotac-v5'; // ⚠️ incrémenter à chaque déploiement qui change app.html/assets

const PRECACHE = [
  '/',
  '/app',
  '/manifest.json',
  '/assets/fox_chill.png',
  '/assets/fox_classe.png',
  '/assets/fox_spicy.png',
  '/assets/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // On ne touche qu'aux GET de notre propre domaine, et jamais à l'API
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  const isPage = e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/app';

  if (isPage) {
    // Pages : réseau d'abord (contenu toujours frais), cache si hors-ligne
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          // Ne jamais mettre en cache une erreur (404/500…) : sinon elle devient permanente
          // jusqu'au prochain bump de version, même une fois le vrai fichier disponible.
          if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
          return r;
        })
        .catch(() => caches.match(e.request).then((m) => m || caches.match('/app')))
    );
  } else {
    // Assets : cache d'abord (rapide), réseau en complément
    e.respondWith(
      caches.match(e.request).then((m) => m || fetch(e.request).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      }))
    );
  }
});

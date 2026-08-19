# 📈 Acquisition — `taco-tac.app/admin/acquisition`

Ce qui se passe depuis la landing page : combien de monde arrive, jusqu'où ils
vont dans l'entonnoir, et l'audience en direct via Google Analytics.

> Le suivi par vidéo TikTok (liens courts `/v/CODE`, relevé de vues/likes,
> diagnostic portée/engagement) a été essayé puis abandonné (2026-08-19) : trop
> de friction à raison de plusieurs vidéos postées par jour, un seul lien
> possible en bio TikTok. Rien de tout ça n'existe plus dans le code.

## Pourquoi côté serveur et pas seulement Google Analytics

GA compte des sessions. Il ne sait pas qui a payé, et rate une part du trafic
(navigateur intégré de TikTok, bloqueurs, iOS). Ici l'entonnoir est mesuré
côté serveur contre le cookie `device_id` signé, et GA reste affiché en
complément pour l'audience et les sources — la page fonctionne entièrement
sans lui s'il tombe.

## Ce que tu vois

- **KPI** : visiteurs uniques, comptes créés, paiements, taux de conversion global
- **Entonnoir** : arrivée → inscription → analyse → paywall → paiement ouvert →
  payé, en appareils distincts, avec le taux de passage marche par marche
- **Chiffre d'affaires par source** et **entonnoir par source** : dormants tant
  qu'aucun lien utilisé ne porte de paramètres `utm_source`/`utm_medium`/etc —
  s'activent tout seuls si tu en ajoutes un jour (une pub, un partenariat),
  aucun code à toucher
- **Google Analytics** : audience en direct (visiteurs en ligne maintenant),
  sessions, durée moyenne, top sources — lu via un compte de service (voir
  section suivante)

## Brancher Google Analytics

Le module lit GA4 avec un compte de service, en signant le JWT avec `node:crypto` —
**aucune dépendance npm ajoutée**.

1. Google Cloud Console → *APIs & Services* → activer **Google Analytics Data API**
2. *IAM & Admin* → *Service Accounts* → créer un compte → *Keys* → *Add key* → **JSON**
3. GA4 → *Admin* → *Property access management* → ajouter l'email du compte de
   service (`...@....iam.gserviceaccount.com`) en rôle **Viewer**
4. GA4 → *Admin* → *Property details* → copier l'**ID numérique** (pas le `G-14KLWFZXYY`)

Puis sur le VPS :

```bash
scp ga4-service-account.json root@VPS:/var/www/tacotac/ga4-service-account.json
```

```
GA4_PROPERTY_ID=123456789
GA4_CREDENTIALS_FILE=/var/www/tacotac/ga4-service-account.json
```

Tant que ce n'est pas fait, le bloc GA affiche précisément ce qui manque, et le
reste de la page fonctionne normalement.

## Installation

```bash
cd /var/www/tacotac/tacotac-app
git pull
pm2 restart tacotac --update-env
```

Les tables se créent seules au démarrage.

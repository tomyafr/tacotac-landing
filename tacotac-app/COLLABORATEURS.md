# Collaborateurs / affiliés

Un **collaborateur** = un créateur qui fait des vidéos pour Tacotac. Il a l'**accès premium complet**, mais avec un statut distinct (`collaborator`) :

- ✅ mêmes fonctionnalités qu'un abonné payant (6 tons, meilleur modèle, 25 analyses/jour)
- ✅ **révocable en 1 commande** quand la collab s'arrête
- ✅ **jamais compté dans ton revenu** (MRR Stripe = uniquement les vrais `premium` payants)
- ✅ chaque vente via son **code promo** lui est rattachée → calcul auto de sa commission

Tout se pilote depuis le VPS, dans `/var/www/tacotac/tacotac-app`, avec un seul script.

## Ajouter un collaborateur

```bash
node collaborator.js add email@dusite.com "Prénom Nom"
```

Ça fait tout d'un coup :
1. crée/active son compte en statut `collaborator` (accès immédiat)
2. génère son **code promo Stripe** (par défaut `-10%` pour ses followers)
3. affiche le code à lui transmettre

Il se connecte ensuite sur l'app **avec cet email** (Google ou mot de passe) → il a tout.
Il partage son code dans ses vidéos.

> Code personnalisé possible : `node collaborator.js add email@x.com "Léo" LEO10`

## Retirer un collaborateur

```bash
node collaborator.js revoke email@dusite.com
```

Repasse son compte en gratuit **et** désactive son code promo. Son historique de ventes est conservé.

## Voir les collaborateurs

```bash
node collaborator.js list
```

## Voir les ventes + commissions

```bash
node collaborator.js sales
```

Récap par collaborateur : nombre de ventes, montant encaissé, et **commission à verser** (calculée avec le % configuré).

## Réglages (optionnels, dans `.env`)

| Variable | Défaut | Rôle |
|---|---|---|
| `COLLAB_COMMISSION_PCT` | `20` | % des ventes reversé au collaborateur |
| `COLLAB_AUDIENCE_DISCOUNT_PCT` | `10` | remise offerte à ses followers via son code |

Après un changement de `.env` : `pm2 restart tacotac`.

## Où sont les données

- **Base** (source de vérité) : tables `collaborators` et `collaborator_sales` dans `tacotac.db`.
- **Google Sheet** : chaque vente est aussi envoyée au Sheet (source `collab-sale`) — pour voir les colonnes `collaborator / code / amount`, ajoute-les à ton script Apps Script (sinon seules les colonnes existantes s'affichent, mais la base garde tout).

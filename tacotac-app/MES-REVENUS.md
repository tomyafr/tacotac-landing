# 💰 Mon dashboard revenus — `taco-tac.app/admin/revenus`

L'espace collaborateur montre ce que gagnent **les autres**. Ici c'est **ton** argent :
ton Stripe Dashboard rapatrié dans Tacotac, plus ce que Stripe ne sait pas.

## Accès

```
https://taco-tac.app/admin/revenus?t=<ADMIN_TOKEN>
```

Même porte que `/admin/tiktok` : le jeton passe une fois en query, puis un cookie
signé prend le relais 12 h. Aucun lien ne pointe vers cette page depuis le site.

## Ce que tu vois

**En haut, ce que la boîte vaut aujourd'hui**

| Indicateur | Comment il est calculé |
|---|---|
| MRR | tous les abonnements actifs ramenés au mois (un annuel à 59,99 € pèse 5,00 €/mois, un hebdo à 4,99 € pèse 21,62 €) — remises récurrentes déduites |
| ARR | MRR × 12 |
| Abonnés payants | statuts `active` + `past_due` ; les essais sont comptés à part |
| Panier moyen | MRR ÷ abonnés actifs |
| Valeur d'un client | panier moyen ÷ churn mensuel — ce qu'un client rapporte avant de partir |
| Churn mensuel | résiliations de la période ramenées à 30 jours |

**Sur la période choisie (7 / 30 / 90 / 365 j)**

Encaissé net (après frais Stripe), nouveaux abonnements et MRR gagné, MRR perdu,
renouvellements attendus sous 7 jours, taux de conversion des essais.

**Puis** : la courbe de l'encaissé jour par jour, la répartition du MRR par formule,
les signaux d'alerte (impayés, cartes refusées, litiges, résiliations programmées),
la trésorerie Stripe (disponible / prochain virement), l'entonnoir inscrit → payant,
les motifs de départ, la part des collaborateurs, et le flux des mouvements en direct.

## Les emails

À chaque mouvement d'argent tu reçois un email :

- 💸 **« clara@gmail.com vient de souscrire un abonnement Premium Mensuel »**
- 🕒 essai gratuit démarré · ⏳ essai qui se termine
- 🔁 renouvellement encaissé
- 👋 résiliation (avec le motif coché dans le portail Stripe)
- ⚠️ paiement refusé · ↩️ remboursement · ⚖️ litige bancaire

Plus un **récap chaque matin à 9 h** : MRR, abonnés, mouvements de la veille,
encaissé, impayés, inscriptions.

Réglages dans `.env` :

```
OWNER_ALERT_EMAILS=tomathieuia@gmail.com   # qui reçoit (défaut : PARTNER_ADMIN_EMAILS)
OWNER_ALERTS=off                            # coupe les alertes à l'unité
OWNER_DIGEST=off                            # coupe le récap quotidien
OWNER_DIGEST_HOUR=9                         # heure du récap (Europe/Paris)
```

## D'où viennent les chiffres

Deux sources, complémentaires :

- **Stripe en direct** (`/v1/subscriptions`, `/v1/balance_transactions`, `/v1/balance`,
  `/v1/payouts`, `/v1/invoices`) → l'état d'aujourd'hui, toujours juste même pour les
  ventes antérieures à l'installation de cette page. Résultat mis en cache 60 s.
- **Table locale `revenue_events`** → l'historique jour par jour et le flux en direct,
  remplie par le webhook. Clé d'idempotence = l'id d'événement Stripe, donc un webhook
  rejoué ne crée ni doublon ni second email.

## Webhook Stripe

Les événements à cocher dans le dashboard Stripe (Developers → Webhooks) :

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.trial_will_end
invoice.paid
invoice.payment_failed
charge.refunded
charge.dispute.created
```

Les quatre premiers étaient déjà nécessaires au fonctionnement du premium ; les cinq
suivants n'alimentent que le dashboard et les alertes. S'ils manquent, rien ne casse :
les chiffres restent justes (ils viennent de Stripe), seuls le flux en direct et les
emails correspondants sont muets.

## Installation

```bash
cd /var/www/tacotac/tacotac-app
git pull
pm2 restart tacotac
```

Aucune migration à lancer : la table se crée toute seule au démarrage.

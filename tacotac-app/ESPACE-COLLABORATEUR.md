# 🦊 Espace collaborateur — `taco-tac.app/partner`

Portail privé où chaque collaborateur suit **en direct** ce que son code promo lui rapporte,
et où toi seul disposes d'une **console d'administration** complète.

Rien ne pointe vers cette page depuis le site : l'URL se donne à la main, aux collaborateurs
uniquement. Une personne qui tombe dessus par hasard ne peut rien voir — il faut être dans la
table `collaborators` (ou être admin) pour entrer.

---

## 1. Le lien à donner

```
https://taco-tac.app/partner
```

(`/collab` mène exactement au même endroit, si tu préfères ce mot.)

## 2. Comment un collaborateur se connecte

Trois chemins, tous avec **l'email de son compte Tacotac** :

| Chemin | Quand |
|---|---|
| **Lien magique par email** | 1re connexion, ou mot de passe oublié → bouton « Première connexion » |
| **Email + mot de passe** | dès qu'il en a créé un dans « Mon profil » |
| **Continuer avec Google** | s'il a créé son compte Tacotac avec Google |

Le tout premier accès part de toi : dans la console admin, **« Renvoyer son lien d'accès »**
lui envoie un email avec un bouton qui le connecte directement (lien valable 7 jours, usage unique).

## 3. Ce qu'il voit

**Tableau de bord** — code promo + lien à copier, et 5 indicateurs qui évoluent avec le filtre
de période (7 j / 30 j / 90 j / 12 mois / depuis le début) :

- abonnements pris via son code · sa commission · le CA généré
- ce qui lui a **déjà été versé** · ce qu'il **reste à recevoir**
- variation vs période précédente sur chaque indicateur, + mini-courbe

Puis quatre graphiques : évolution des gains (aire + barres, avec infobulle au survol),
répartition par formule (donut hebdo/mensuel/annuel), commission cumulée, meilleurs jours
de la semaine. Enfin l'historique de ses versements.

**Mes ventes** — chaque vente ligne à ligne (date, client anonymisé, formule, montant, sa
commission), filtres par formule, recherche, et **export CSV**.

**Mon profil** — nom affiché, réseau, moyen de paiement, création de mot de passe, et le rappel
de son contrat (taux de commission, remise communauté, date d'entrée, Premium offert).

> Les emails clients sont **masqués** (`cl••••••@gmail.com`) : le collaborateur reconnaît ses
> ventes sans récupérer la base clients.

## 4. Ta console admin

Visible uniquement pour les emails de `PARTNER_ADMIN_EMAILS` (`.env`), onglet **Console admin** :

- vue d'ensemble : collaborateurs actifs, ventes attribuées, CA affilié, **commissions dues**
- graphique global du programme d'affiliation (90 jours)
- tableau de tous les collaborateurs : ventes, CA, commission, reste dû, statut, « jamais connecté »
- fiche par collaborateur (clic sur la ligne) :
  - modifier son **taux de commission** et son nom
  - **noter un versement** (montant + note) → son « reste à recevoir » baisse d'autant chez lui
  - **voir son tableau de bord** exactement comme lui
  - **renvoyer son lien d'accès** par email
  - **révoquer** (retire le Premium + désactive le code promo Stripe) ou **réactiver**
- **« + Ajouter un collaborateur »** : crée d'un coup le coupon + code promo Stripe, le compte
  Premium, la ligne en base, et lui envoie son email de bienvenue avec son lien d'accès.

## 5. Installation sur le VPS

```bash
cd /var/www/tacotac/tacotac-app
git pull
```

Ajoute dans `.env` (une seule ligne nouvelle) :

```
PARTNER_ADMIN_EMAILS=tomathieuia@gmail.com
```

Puis crée/vérifie les comptes des collaborateurs déjà présents dans le Google Sheet :

```bash
node seed-collaborators.js --invite
```

(sans `--invite`, il crée/vérifie sans envoyer d'email — le script est relançable sans risque)

```bash
pm2 restart tacotac
```

Vérifie enfin que l'URI de redirection Google `https://taco-tac.app/api/auth/google/callback`
est bien déclarée (c'est déjà le cas si le bouton Google marche sur l'app).

## 6. D'où viennent les chiffres

Aucune saisie manuelle. Quand quelqu'un paie sur Stripe avec un code promo, le webhook
`checkout.session.completed` retrouve le collaborateur via l'id du `promotion_code` et écrit la
vente dans `collaborator_sales` (idempotent : jamais deux fois la même). Le tableau de bord ne
fait que lire cette table. Seuls les **versements** sont saisis par toi, dans la console.

Un collaborateur n'est **jamais** compté dans ton MRR : son plan est `collaborator`, distinct
de `premium`.

## 7. Ligne de commande (toujours disponible)

`node collaborator.js add|revoke|list|sales|sync` continue de fonctionner exactement pareil —
la console web et le CLI écrivent dans la même base.

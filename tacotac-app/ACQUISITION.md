# 📈 Acquisition — `taco-tac.app/admin/acquisition`

Répond à **une seule question**, la seule qui te dise quoi tourner ensuite :
**quelle vidéo rapporte de l'argent ?**

Pas « quelle vidéo fait des vues ». Quelle vidéo **paye**.

---

## 1. Pourquoi ce n'est pas Google Analytics

GA compte des sessions. Il ne sait pas qui a sorti sa carte. Et il rate une part
du trafic : le navigateur intégré de TikTok, les bloqueurs et iOS avalent une
partie des événements `gtag()`.

Ici tout est écrit **côté serveur**, contre le cookie `device_id` signé — le même
identifiant qui part chez Stripe en `client_reference_id`. C'est ce chaînon qui
permet de dire « la vidéo `dm3` a rapporté 149 € », des mois après le premier clic.

GA reste branché et utile (audience en direct, sources, pays, appareils) : la page
affiche les deux côte à côte. Mais si GA tombe, les chiffres qui comptent restent là.

---

## 2. La chaîne, en une phrase

```
lien en bio /v/dm3  →  clic compté  →  redirection avec utm_content=dm3
      →  attribution collée au cookie device_id  →  inscription  →  Stripe
      →  au paiement, l'euro remonte jusqu'à la vidéo
```

Le **premier contact est figé** : si quelqu'un arrive par ta vidéo, repart, et
revient trois semaines plus tard en tapant l'URL, c'est toujours la vidéo qui est
créditée. C'est elle qui a fait entrer la personne.

---

## 3. Ton rituel (2 minutes par vidéo)

**Avant de poster** — crée le lien dans la page, en bas à gauche :

| Champ | Exemple |
|---|---|
| Code court | `dm3` |
| Date de publication | la date du post |
| De quoi parle la vidéo | `POV mode spicy — réponse au dernier message` |

Tu obtiens `https://taco-tac.app/v/dm3`. **Mets-le en bio.** Sans lui, la vidéo
n'existe pas dans le tableau.

**Une fois par semaine** — ouvre TikTok Studio, et colle les chiffres dans le
bloc « Relever les stats TikTok », une ligne par vidéo :

```
dm3	45000	2700	140	95
rep7	22000	990	60	30
```

`code · vues · likes · commentaires · partages`. Tabulation, virgule ou
point-virgule, peu importe. `12,4K` et `12 400` sont compris tous les deux.

> L'app TikTok ayant été refusée à l'audit, l'API ne donne pas ces chiffres —
> c'est la seule saisie manuelle de tout le système.

---

## 4. Lire le tableau

| Colonne | Ce qu'elle te dit |
|---|---|
| Taux de like | est-ce que la vidéo **plaît** (likes ÷ vues) |
| Clic/vue | est-ce qu'elle **donne envie d'aller voir** (typiquement 0,5 % à 3 %) |
| Inscrits, Ventes | ce qui se passe **après** le clic |
| € générés | ce que la vidéo a rapporté, pour de vrai |
| **€ / 1000 vues** | **la colonne qui décide** |

`€/1000 vues` est le seul chiffre qui compare honnêtement une vidéo à 200 000 vues
et une à 5 000. Une vidéo tiède qui amène des abonnés bat une virale qui ne
convertit pas. **Trie sur cette colonne, refais ce qui est en haut.**

---

## 5. « Mes likes baissent alors que je fais mieux »

Le bloc **Portée ou engagement ?** tranche. Barres = vues, ligne = taux de like.
Il compare tes premières vidéos à tes dernières et te donne un verdict :

- **Les vues chutent, le taux de like tient** → ce n'est pas toi, c'est la
  distribution. Les gens qui te voient t'aiment autant, TikTok te montre juste à
  moins de monde. Cherche ce qui a changé au moment de la bascule : rythme de
  publication, sons, lien en bio, un signalement.
- **Les vues tiennent, le taux de like chute** → c'est le contenu. Autant de monde
  te voit, moins de gens accrochent. Les 2 premières secondes et le sujet passent
  avant la qualité de production.
- **Les deux baissent** → repars du format le mieux classé en €/1000 vues.

Ce sont deux problèmes opposés, avec deux remèdes opposés. Aujourd'hui tu ne peux
pas les distinguer — c'est exactement le trou que ce bloc bouche.

---

## 6. L'entonnoir

Six marches, en appareils distincts : arrivés → compte créé → ont analysé → ont vu
le paywall → ont ouvert le paiement → ont payé. Le pourcentage est le passage
depuis la marche du dessus. **Celle où il s'effondre est celle qui coûte le plus cher.**

Le même entonnoir est découpé par source : c'est là qu'on voit qu'un canal amène
du monde mais que personne ne paie.

---

## 7. Brancher Google Analytics

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

---

## 8. Installation

```bash
cd /var/www/tacotac/tacotac-app
git pull
pm2 restart tacotac
```

Les tables se créent seules au démarrage. **Le tracking tourne sur le VPS, en
permanence** — ton ordinateur peut être éteint, les clics et les ventes continuent
d'être enregistrés.

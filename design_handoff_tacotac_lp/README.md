# Handoff : Landing Page Tacotac (liste d'attente)

## Overview
Landing page mobile-first pour **Tacotac**, un coach de dating IA français. Objectif unique : **capter l'email** du visiteur pour la liste d'attente d'accès anticipé. La page enchaîne : accroche + formulaire, preuve sociale, démo interactive du produit, relances de capture, réassurance, avis, FAQ, CTA final, + une barre CTA collante et une modale de sortie.

Le mascotte (un renard illustré) porte toute la personnalité de la marque : ne pas le remplacer par des icônes génériques.

---

## About the Design Files
Le fichier `Tacotac.dc.html` de ce bundle est une **référence de design en HTML** — un prototype qui montre le rendu et le comportement voulus, **pas du code de production à copier tel quel**. Il est écrit dans un format « Design Component » propriétaire (balises `<helmet>`, attributs `style-hover`, etc.) qui **ne fonctionnera pas hors de son environnement d'origine**.

La tâche : **recréer ce design dans l'environnement cible** (l'utilisateur a déjà un site statique en HTML/Tailwind — voir plus bas — mais tu peux le porter en React/Next, Astro, Vue, etc. selon le projet), en respectant fidèlement les valeurs de design ci-dessous. Si aucun environnement n'existe, un simple `index.html` + Tailwind (via CDN ou build) suffit : c'est déjà la stack de la LP actuelle.

## Fidelity
**Haute fidélité (hifi).** Couleurs, typographie, espacements et interactions sont finaux. Recréer l'UI au pixel près à partir des tokens et des specs de sections ci-dessous.

---

## Design Tokens

### Couleurs
| Rôle | Hex |
|---|---|
| Fond crème (sections claires) | `#F4EEE2` |
| Carte crème claire (champs, cartes claires) | `#FBF7EF` |
| Blanc pur (carte chat démo) | `#FFFFFF` |
| Espresso / fond sombre (sections foncées, texte) | `#17120E` |
| Orange signature (accent, CTA) | `#FF5A1F` |
| Rust (texte accent sur fond clair, bordures) | `#C4400F` |
| Orange clair (texte sur fond sombre : bouton copier) | `#FF7A45` |
| Texte secondaire sur clair (muted) | `#8A7F70` |
| Texte tertiaire / chips sur clair | `#6B6153` |
| Texte secondaire sur sombre | `#9C9082` |
| Texte de corps sur sombre (avis) | `#B5ABA0` |
| Texte footer / très discret sur sombre | `#5C5348` |
| Filet (hairline) sur clair | `rgba(23,18,14,0.10)` |
| Filet (hairline) sur sombre | `rgba(255,255,255,0.07)` — parfois `0.06` / `0.08` |

Avatars preuve sociale / avis (dégradés) :
- T : `linear-gradient(135deg,#7c3aed,#a855f7)`
- K : `linear-gradient(135deg,#059669,#10b981)`
- A : `linear-gradient(135deg,#d97706,#f59e0b)`
- + : `#FF5A1F` plein
- Avatar « Sophie » (démo) : `linear-gradient(135deg,#f472b6,#e11d48)`
- Pastille « en ligne » (démo) : `#22c55e`

### Typographie
Deux familles, chargées depuis **Fontshare** :
```html
<link rel="preconnect" href="https://api.fontshare.com" crossorigin>
<link href="https://api.fontshare.com/v2/css?f[]=clash-display@600,700&f[]=general-sans@400,500,600,700&display=swap" rel="stylesheet">
```
- **Clash Display** (600, 700) → tous les titres (`h1`, `h2`, `h3` de section), les grands chiffres de stats, les numéros d'étapes, le logo.
- **General Sans** (400/500/600/700) → tout le corps de texte, boutons, champs, UI. C'est la `font-family` par défaut du `body`.

Échelle typo (px) :
| Usage | Font | Taille | Poids | Interlignage | Tracking |
|---|---|---|---|---|---|
| H1 hero | Clash Display | `clamp(46px,14vw,58px)` | 700 | 0.94 | -0.03em |
| H2 démo | Clash Display | `clamp(30px,8vw,38px)` | 600 | 1.02 | -0.02em |
| H2 « Comment ça marche » | Clash Display | `clamp(30px,8vw,36px)` | 600 | 1.0 | -0.02em |
| H2 FAQ | Clash Display | `clamp(28px,7vw,34px)` | 600 | 1.0 | -0.02em |
| H2 CTA final | Clash Display | `clamp(38px,11vw,48px)` | 700 | 0.96 | -0.03em |
| H2 « Ça te parle ? » | Clash Display | 28px | 600 | — | -0.02em |
| Chiffres stats / numéros étapes | Clash Display | 30–34px | 700 | 1.0 | -0.02em |
| Sous-titre hero | General Sans | 16.5px | 400 (mots-clés 600) | 1.5 | — |
| Corps / avis | General Sans | 13.5–15px | 400 | 1.5–1.6 | — |
| Boutons | General Sans | 15–16px | 600 | — | — |
| Kicker (sur-titre) | General Sans | 11px | 600 | — | 0.16em, UPPERCASE |
| Badge hero | General Sans | 11px | 600 | — | 0.14em, UPPERCASE |
| Micro-copy / labels | General Sans | 11–12.5px | 400–600 | — | — |

### Rayons, ombres, espacements
- **Rayons** : boutons & champs `13px` · petit bouton (copier, mini) `11–12px` · cartes `14–22px` · pastilles/chips/badges `999px` · glider sélecteur `10px`.
- **Ombres** :
  - CTA orange : `0 6px 18px rgba(216,67,14,0.28)` → hover `0 10px 26px rgba(216,67,14,0.4)`
  - Bouton ink (CTA final) : `0 8px 22px rgba(0,0,0,0.22)`
  - Carte chat démo : `0 12px 34px rgba(23,18,14,0.10)`
  - Colonne app (desktop) : `0 0 90px rgba(0,0,0,0.5)`
  - Modale : `0 30px 80px rgba(0,0,0,0.5)`
  - Drop-shadow renard hero : `drop-shadow(0 14px 22px rgba(23,18,14,0.18))`
- **Padding sections** : ~`56px 24px` (grandes sections claires), `48px 24px` (capture post-démo), `30px 20px` (stats), `52px 24px 46px` (hero), `34px 24px` (footer).
- **Largeur max colonne app** : `460px`, centrée. Formulaires : max `332px`. Timeline étapes : max `360px`. FAQ : max `400px`.

### Layout global
- **Mobile-first, une seule colonne de `max-width:460px` centrée.** Sur desktop, le `body` a un fond espresso `#17120E` et la colonne crème « flotte » au centre avec l'ombre `0 0 90px rgba(0,0,0,0.5)`. Sur mobile la colonne remplit la largeur.
- **Rythme visuel** : alternance stricte crème `#F4EEE2` / espresso `#17120E` section par section, finale orange `#FF5A1F`.
  1. Hero — crème
  2. Stats — espresso
  3. Démo — crème
  4. Capture post-démo — espresso
  5. Comment ça marche — crème
  6. Avis + réassurance — espresso
  7. FAQ — crème
  8. CTA final — orange
  9. Footer — espresso

---

## Screens / Views (une page, sections séquentielles)

### Nav (fixe, apparaît au scroll)
- Position `fixed` haut, `z-index:60`, largeur alignée sur la colonne (`max-width:460px`).
- **Caché par défaut** (`translateY(-100%)`), **apparaît quand `scrollY > 620`** (`translateY(0)`), transition `.35s ease`.
- Fond `rgba(23,18,14,0.88)` + `backdrop-filter:blur(12px)`, filet bas `rgba(255,255,255,0.08)`, padding `11px 18px`.
- Gauche : mini-renard (`assets/renard.png`, 26×26) + « Tacotac » (Clash Display 600, 16px, `#F4EEE2`).
- Droite : bouton « Rejoindre » — fond `#FF5A1F`, texte blanc 600 13px, rayon 11px, padding `9px 16px`, ancre vers `#tt-cta`.

### 1. Hero (crème)
- **Badge** : pastille inline-flex, fond `rgba(216,67,14,0.07)`, bordure `1px rgba(216,67,14,0.22)`, texte `#C4400F` 11px 600 UPPERCASE tracking 0.14em, rayon 999px, padding `7px 15px`. Contient une **puce ronde 6px `#FF5A1F` qui pulse** (opacity 1↔0.3, 1.8s) + « Coach dating IA · Accès anticipé ».
- **Mascotte** : `assets/renard.png`, largeur 150px, centrée, **animation flottante** (translateY 0↔-9px, 5s ease-in-out infini). Sous elle, une ellipse d'ombre floue `120×15px`, `radial-gradient(ellipse, rgba(23,18,14,0.22), transparent 70%)`, `blur(3px)`.
- **H1** : « Fini de sécher » (ink `#17120E`) + saut de ligne + « en DM. » (orange `#FF5A1F`). Specs typo ci-dessus.
- **Sous-titre** : « Envoie 1 screenshot, reçois **3 réponses qui claquent**. Classe, drôle ou spicy — en 3 secondes. » (mots en gras = `#17120E` 600, reste `#8A7F70`). max-width 312px.
- **Formulaire email (source `hero`)** :
  - Champ email : fond `#FBF7EF`, bordure `1.5px rgba(23,18,14,0.14)`, texte `#17120E`, rayon 13px, padding `15px 18px`, placeholder « ton@email.fr ». **Focus** : bordure `#FF5A1F` + `box-shadow:0 0 0 4px rgba(255,90,31,0.12)`.
  - Bouton « Rejoindre la liste » : fond `#FF5A1F`, texte blanc 600 16px, rayon 13px, padding `15px 24px`, ombre CTA. **Hover** : `translateY(-2px)` + ombre renforcée + `brightness(1.04)`. **Active** : `scale(.98)`.
  - Sous le bouton : 3 items micro-copy avec `✓` orange : « 2 analyses offertes · Sans carte · Zéro spam ».
- **Preuve sociale** : pile de 4 avatars 28px (initiales T/K/A/+, bordure 2px couleur du fond crème, se chevauchant `-9px`) + à droite « ★★★★★ » orange + « +1 200 déjà inscrits » (`#8A7F70` 12px).
- **Chips compatibilité** : label « Compatible » + 4 chips (Tinder, Hinge, Bumble, Instagram) : fond `rgba(23,18,14,0.05)`, bordure `1px rgba(23,18,14,0.09)`, texte `#6B6153` 12px 600, rayon 999px, padding `5px 12px`.

### 2. Stats (espresso)
- Grille 3 colonnes, texte centré, séparateurs verticaux `1px rgba(255,255,255,0.08)` autour de la colonne du milieu.
- Chaque stat : grand chiffre Clash Display 30px 700 `#FF5A1F` + label `#9C9082` 11.5px.
  - `×3` — « options par message »
  - `3s` — « par réponse »
  - `100%` — « privé »
- **Comportement** : compteur animé (count-up) qui démarre quand la stat entre à l'écran (voir Interactions).

### 3. Démo interactive (crème) — pièce maîtresse
- Kicker « Démo interactive » (`#C4400F`), H2 « D'un screenshot à la bonne réponse », sous-titre « Change le ton, regarde le renard s'adapter. »
- **Carte « avant »** (simulateur de conv) : fond blanc, rayon 22px, ombre `0 12px 34px rgba(23,18,14,0.10)`.
  - En-tête : avatar rond 42px (dégradé rose/rouge), « Sophie » (600 14px `#17120E`) + « En ligne il y a 2h » (`#b3aca4` 12px), pastille verte `#22c55e` 8px à droite.
  - Bulles reçues (align-left, fond `#f3f0ec`, texte `#2a2620`, rayon `16px 16px 16px 5px`) : « Haha t'es vraiment trop », « Tu fais quoi ce week-end ? ».
  - Bulle « vide » (align-right, fond blanc, bordure `1.5px dashed rgba(23,18,14,0.16)`, texte `#c7bfb6`, rayon `16px 16px 5px 16px`) : « Hm… je réponds quoi là ? ».
- **Bandeau « analyse »** : pastille `rgba(255,90,31,0.07)` bordure `rgba(216,67,14,0.16)`, texte `#C4400F` 13px 600, rayon 999px. SVG spinner (cercle ouvert, stroke `#C4400F`) **en rotation continue 1.6s**. Texte « Tacotac analyse · 3 options générées ».
- **Sélecteur de ton (segmented control)** : conteneur `rgba(23,18,14,0.06)` rayon 14px padding 5px, 3 boutons flex égaux.
  - Un **« glider »** absolu (largeur = 1/3, fond `#FF5A1F`, rayon 10px, ombre `0 4px 14px rgba(216,67,14,0.4)`) glisse derrière le bouton actif — `transform:translateX(index*100%)`, transition `.35s cubic-bezier(.34,1.3,.4,1)`.
  - Boutons (General Sans 600 13.5px) : « 🎩 Classe » (index 0), « 😏 Drôle » (index 1, actif par défaut), « 🌶 Spicy » (index 2). Texte du bouton actif = blanc `#fff`, inactifs = `#8A7F70`, transition color `.25s`.
- **Renard qui change** : `<img>` 150px de haut. Change de source selon le ton, avec micro-animation (opacity 0, `translateY(8px) scale(.96)` puis retour). transition `opacity .25s, transform .3s cubic-bezier(.34,1.3,.4,1)`.
  - Classe → `assets/renard_classe.png` · Drôle → `assets/renard_chill.png` · Spicy → `assets/renard_dragueur.png`.
- **Carte réponse** (espresso, rayon 22px) : en-tête = mini-renard dans carré orange 30px + « Tacotac suggère » (`#F4EEE2` 600 14px) + « ··· » à droite. Puis la **réponse** (italique, `#F4EEE2`, 16px, interlignage 1.6) qui change selon le ton :
  - Classe : « J'avais rien de prévu, mais là ça donne des idées. T'as un endroit en tête ? »
  - Drôle (défaut) : « J'avais prévu rien d'intéressant, mais là ça change. T'as une idée ? »
  - Spicy : « Soirée libre… mais ça dépend de ce qu'on me propose. T'as quoi en tête ? »
  - Bouton « Copier la réponse » : fond `rgba(255,90,31,0.12)`, texte `#FF7A45` 600 14px, bordure `1px rgba(255,90,31,0.25)`, rayon 11px. Au clic : copie le texte (sans guillemets) et affiche « Copié ✓ » 1,5s.

### 4. Capture post-démo (espresso)
- H2 « Ça te parle ? », sous-texte « Rejoins la liste et sois parmi les premiers à ne plus jamais sécher. »
- **Formulaire (source `post-demo`)**, variante sombre : champ fond `rgba(255,255,255,0.05)` bordure `rgba(255,255,255,0.14)` texte blanc (focus bordure orange + halo). Bouton orange « Je veux l'accès en avant-première ».

### 5. Comment ça marche (crème)
- Kicker « En 3 étapes », H2 « Comment ça marche ».
- 3 lignes (flex, gap 24px, max 360px) : gros numéro Clash 34px `#FF5A1F` (min-width 40px) + titre (600 16px `#17120E`) + description (`#8A7F70` 13.5px) :
  - **01 Envoie ton screenshot** — « La conv qui te bloque, capturée en 1 clic. »
  - **02 Choisis ton ton** — « Classe, drôle ou spicy — selon ton match. »
  - **03 Copie & envoie** — « 3 réponses prêtes. Tu n'as plus qu'à choisir. »

### 6. Avis + réassurance (espresso)
- **3 mini-cartes réassurance** (grille 3 col, gap 10px) : fond `rgba(255,255,255,0.04)`, bordure `rgba(255,255,255,0.07)`, rayon 16px. Icône dans carré 34px `rgba(255,90,31,0.14)` :
  - « FR » (texte `#FF7A45` 700) — **Fait en France** / « Conçu & hébergé en Europe »
  - éclair (SVG rempli `#FF7A45`) — **Réponse en 3 sec** / « IA rapide, zéro attente »
  - cadenas (SVG `#FF7A45`) — **Zéro stockage** / « Analysé puis effacé »
- **Barre note** : filet — « ★★★★★ » orange — « 4,9/5 » (`#F4EEE2` 600) — filet.
- **3 cartes d'avis** : fond `rgba(255,255,255,0.03)`, bordure `rgba(255,255,255,0.07)`, rayon 18px, padding 20px. En-tête = avatar 38px (dégradé) avec initiale + pseudo (`#F4EEE2` 600 14px) + ville·âge (`#7A7062` 12px) + « ★★★★★ » orange 12px à droite. Citation en guillemets français `«  »`, `#B5ABA0` 14px interlignage 1.6 :
  - **Thomas_R** · Paris · 26 ans : « L'option Spicy m'a valu un rendez-vous le soir même. Jamais je n'aurais trouvé ça tout seul. »
  - **Kilian.M** · Lyon · 23 ans : « J'envoyais les pires réponses. Depuis Tacotac, mes matchs me répondent. Simple comme ça. »
  - **Alex_bdx** · Bordeaux · 28 ans : « Le mode Classe m'a sauvé deux fois cette semaine. L'IA comprend le contexte mieux que mes potes. »

> Note : chiffres et avis sont des **placeholders** — à remplacer par de vrais témoignages/metrics avant prod.

### 7. FAQ (crème)
- H2 « Questions fréquentes ». 4 items accordéon (max 400px, gap 10px).
- Item : fond `#FBF7EF`, bordure `1px rgba(23,18,14,0.10)`, rayon 14px. Bouton question (600 15px `#17120E`) + signe « + » orange 20px à droite qui **tourne à 45° quand ouvert** (devient « × »). Réponse : hauteur animée (`max-height` 0 ↔ scrollHeight, `.35s ease`), texte `#8A7F70` 13.5px 1.6. **Un seul ouvert à la fois** ; l'item ouvert prend une bordure `rgba(216,67,14,0.35)`.
- Contenu :
  1. « Et si les réponses ne me plaisent pas ? » → « Tu as 3 tons à chaque fois, et tu peux régénérer autant que tu veux jusqu'à trouver celle qui te ressemble. C'est toi qui choisis, toujours. »
  2. « Mes conversations sont-elles stockées ? » → « Non. Ton screenshot est analysé puis immédiatement effacé. Rien n'est conservé sur nos serveurs. »
  3. « Ça marche sur quelles applis ? » → « Toutes : Tinder, Hinge, Bumble, Instagram, Snap… Tant que tu peux faire un screenshot, Tacotac comprend. »
  4. « C'est dispo quand ? » → « Très bientôt. Laisse ton email : les inscrits de la liste d'attente y ont accès en premier, avec 2 analyses offertes. »

### 8. CTA final (orange `#FF5A1F`) — `id="tt-cta"`
- Renard `assets/renard.png` 92px, flottant. H2 blanc « Prêt pour le lancement ? ». Paragraphe blanc (opacity .92) « Laisse ton email, on te prévient en premier dès l'ouverture — avec tes 2 analyses offertes. »
- **Indicateur de rareté** : ligne « Places en accès anticipé » / « 83% » (blanc 12px 600), barre de progression (piste `rgba(255,255,255,0.28)` rayon 999px hauteur 7px, remplissage blanc 83%), légende « Il ne reste que quelques places prioritaires. »
- **Formulaire (source `cta-final`)** : champ fond `rgba(255,255,255,0.92)` texte `#17120E` sans bordure. Bouton **ink** `#17120E` texte blanc « Rejoindre la liste d'attente » (contraste fort sur orange). Message d'erreur sur fond `rgba(0,0,0,0.22)`.
- Micro-copy « Tu seras prévenu en premier. Pas de spam, promis. »

### 9. Footer (espresso)
- Renard 44px opacity .85 + « © 2026 Tacotac · Fait avec soin en France » (`#5C5348` 12px).

### Barre CTA collante (bas, fixe)
- `position:fixed` bas, `z-index:50`, largeur colonne. **Cachée par défaut** (`translateY(130%)`), **apparaît quand `scrollY > 1000`** (sauf si déjà inscrit), transition `.4s cubic-bezier(.22,.68,0,1.1)`.
- Fond `rgba(23,18,14,0.92)` + blur. Formulaire (source `sticky`) : champ email sombre plein largeur + bouton rond orange 46px avec « → ». Au succès : « Tu es sur la liste. »

### Modale exit-intent
- Overlay `rgba(23,18,14,0.72)` + `blur(6px)`, `z-index:80`. Carte crème `#FBF7EF` max 390px, rayon 24px, bordure `rgba(216,67,14,0.25)`, ombre `0 30px 80px rgba(0,0,0,0.5)`. Entrée : opacity 0→1 + carte `translateY(16px)`→0, `.4s`.
- Bouton fermer « ✕ » rond 30px en haut à droite. Renard `assets/renard_dragueur.png` 108px. Titre « Attends… », texte « Pars pas les mains vides. Rejoins la liste et débloque **2 analyses offertes** au lancement. » Formulaire (source `modal`) champ clair + bouton orange « Je réserve ma place ». Micro-copy « Sans carte bancaire · Zéro spam ».
- **Déclenchement** : au `mouseout` vers le haut de la fenêtre (`e.clientY <= 0`) **OU** après 30s. Ne s'affiche **qu'une fois** (flag `localStorage` `tt_modal`), jamais si déjà inscrit. Fermeture : bouton ✕ ou clic sur l'overlay.

---

## Interactions & Behavior

- **Nav** : visible si `scrollY > 620`.
- **Sticky CTA** : visible si `scrollY > 1000` et non inscrit.
- **Sélecteur de ton** : au clic, (1) recolore les boutons (actif blanc / inactifs `#8A7F70`), (2) déplace le glider `translateX(index*100%)`, (3) fond-enchaîne le texte de réponse (opacity 0 → change texte → 1, ~170ms), (4) fond-enchaîne l'image du renard (~200ms).
- **Copier** : `navigator.clipboard.writeText(texte sans guillemets)`, feedback « Copié ✓ » 1,5s.
- **FAQ** : accordéon exclusif, animation `max-height`, rotation du « + » à 45°, bordure active orange.
- **Reveal au scroll** : chaque élément `[data-reveal]` démarre à `opacity:0` + `translateY(22px)`, transition `.7s cubic-bezier(.16,.84,.28,1)`, révélé via `IntersectionObserver` (threshold 0.12), une seule fois. **Fallback** : si pas d'IntersectionObserver, tout est visible.
- **Count-up stats** : au passage à l'écran (threshold 0.5), animation `requestAnimationFrame` sur ~1100ms, préfixe/suffixe conservés (`×`, `s`, `%`).
- **Reduced motion** : `@media (prefers-reduced-motion: reduce) { * { animation: none !important } }`.
- **Responsive** : layout unique en colonne 460px ; les tailles de titres utilisent `clamp()` pour s'adapter aux petits écrans.

### États des formulaires (5 formulaires, mêmes règles)
Sources : `hero`, `post-demo`, `cta-final`, `sticky`, `modal`.
- **Validation** email : regex `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`. Si invalide → message d'erreur inline + focus sur le champ, pas d'envoi.
- **Envoi** : bouton désactivé + « Envoi… » (ou « … » pour le mini bouton), puis appel réseau.
- **Succès** : on masque **tous** les formulaires et on affiche **tous** les blocs succès (état « inscrit » global), on cache la sticky. Persisté via `localStorage` `tt_subscribed = '1'` → au rechargement, tout est en état succès.
- **Erreur réseau** : ignorée volontairement (voir ci-dessous), l'inscription est considérée réussie côté UI.

---

## State Management
- `tt_subscribed` (localStorage) : « 1 » quand l'utilisateur s'est inscrit → force l'état succès partout, masque la sticky, empêche la modale.
- `tt_modal` (localStorage) : « 1 » quand la modale a déjà été montrée une fois.
- Position de scroll : lue en continu (listener passif) pour la nav et la sticky.

### Backend / envoi email (à recâbler proprement)
Le prototype poste vers un **Google Apps Script webhook** en `GET` + `mode:'no-cors'` (réponse opaque, donc « succès » optimiste — d'où l'absence de gestion d'erreur réseau) :
```
GET https://script.google.com/macros/s/AKfycbzuCip2KWPlPw7kudrsvP2DuZ94-W6yw6aJ7c_HiSFZysXaPfsvG57uq6lhDsDpGYudtw/exec
    ?email=<email>&source=<source>&timestamp=<ISO>
```
En production, remplacer par un vrai endpoint (API interne, Mailchimp/Brevo/Resend, etc.) **avec** une vraie gestion succès/erreur. Le champ `source` sert au tracking de la provenance de l'inscription — à conserver.

> Le prototype d'origine incluait aussi Google Analytics (`gtag`, ID `G-14KLWFZXYY`) sur les événements d'inscription et de clic de ton — non repris ici, à réintégrer si besoin.

---

## Assets
Illustrations du renard (PNG détourés, fond transparent) dans `assets/` :
- `renard.png` — renard bras croisés, chemise crème (hero, nav, carte réponse, CTA final, footer).
- `renard_classe.png` — renard en costume + lunettes (ton **Classe**).
- `renard_chill.png` — renard décontracté (ton **Drôle**, défaut).
- `renard_dragueur.png` — renard veste bordeaux + rose (ton **Spicy**, modale).

Aucune autre image externe ; les icônes de réassurance et le spinner sont des **SVG inline** (voir le HTML). Les avatars sont des `<div>` avec dégradés + initiale, pas des images.

---

## Files
- `Tacotac.dc.html` — le design de référence complet (template + logique). Format « Design Component » : le markup vit entre les balises implicites du composant, la logique dans une classe `Component`. **Lire ce fichier pour les valeurs exactes**, mais le réécrire dans la stack cible (ex. `index.html` + Tailwind, ou composants React).
- `assets/` — les 4 illustrations du renard.

### Stack actuelle de l'utilisateur (contexte)
La LP live tourne en **HTML statique + Tailwind (CDN)** avec Bricolage Grotesque / Space Grotesk. Ce handoff propose une refonte visuelle (crème/espresso/orange, Clash Display + General Sans). Pour recréer à l'identique le plus simplement : un seul fichier HTML, Tailwind, les fonts Fontshare, et les 4 PNG — en reprenant les tokens ci-dessus.

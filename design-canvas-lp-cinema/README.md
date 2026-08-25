# LP Tacotac — version « pub télé » (maquette Claude Design)

Maquette haute-fidélité de la refonte de la landing page : le hero n'est plus une
image fixe, c'est un **film de 19 s qui tourne en boucle** dans un mockup de
téléphone en 3D.

> ⚠️ Ce dossier est une **maquette**, pas du code de prod. Le fichier `.dc.html`
> est au format « Design Component » (balises `<x-dc>`, `<helmet>`, classe
> `Component extends DCLogic`) : il ne s'ouvre pas tel quel dans un navigateur,
> il tourne dans l'éditeur Claude Design. La prod, c'est `index.html` à la racine.

## Le film du hero — 4 actes

| Acte | Ce qu'on voit | Timing |
|---|---|---|
| 1 | DM Instagram : Sophie écrit, les bulles tombent une par une, puis le curseur clignote dans le champ vide — le silence gênant. Le renard se secoue. | 0 – 5,4 s |
| 2 | Flash blanc + cadre de capture : le screenshot est pris. | 5,4 – 6,6 s |
| 3 | L'app Tacotac remonte par-dessus l'écran. Ligne de scan orange sur la vignette, « Analyse… » → « Prêt », les 3 réponses se distribuent, la « Drôle » est choisie et copiée. | 6,6 – 13,2 s |
| 4 | Retour au DM : la réponse part (bulle dégradé Instagram), Sophie retape, puis « 😏 Ok là tu m'intrigues. Samedi ? » | 13,2 – 19,5 s |

Trois libellés de chapitre sous le téléphone suivent la progression :
*Le DM qui coince* → *1 screenshot* → *3 réponses. 1 date.*

Le film ne tourne **que quand il est à l'écran** (`IntersectionObserver`) et se
fige sur l'acte 3 si `prefers-reduced-motion: reduce`.

## Le reste de la page

Sections reprises du handoff d'origine (stats, comment ça marche, avis, FAQ, CTA
final, footer, sticky bar, modale exit-intent) avec le polish en plus : grain
cinéma en SVG inline, halos animés, parallaxe 3D du téléphone à la souris,
marquee des applis compatibles, hover sur les cartes d'avis.

La section démo devient « À toi de jouer » : le sélecteur de ton reste
interactif — le film montre, la démo laisse essayer.

## Charte respectée

Tokens et typos inchangés (`design_handoff_tacotac_lp/README.md` fait foi) :
crème `#F4EEE2`, espresso `#17120E`, orange `#FF5A1F`, rust `#C4400F`,
Clash Display + General Sans via Fontshare. Colonne mobile-first 460 px.
Seul ajout : `#0D0A08` pour le fond ambiant derrière la colonne sur desktop.

## Fichiers

- `Main.dc.html` — la maquette complète (markup + CSS + timeline du film).
- `canvas.json` — layout de l'artboard.
- `assets/` — les 4 renards redimensionnés en 190 px de large (les originaux
  401×623 pèsent trop lourd pour être embarqués dans le canvas).

## Régénérer le canvas

Depuis ce dossier, avec le skill `design` chargé (`/design`) :

```bash
node "<base-du-skill>/seed-canvas.mjs" --template "<base-du-skill>/payload.template.html" --out tacotac-landing-cinema.html --title "Tacotac Landing Cinema" --artboard Main.dc.html --image assets/renard.png --image assets/renard_chill.png --image assets/renard_classe.png --image assets/renard_dragueur.png --canvas canvas.json
```

Puis republier le `.html` obtenu sur l'artifact existant pour garder la même URL.

Pour refaire les images redimensionnées depuis les originales (PowerShell) :
System.Drawing, largeur cible 190 px — voir l'historique de la conversation ou
refaire un simple resize bicubique.

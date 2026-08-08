# Tacotac — travail multi-machine

Ce repo est travaillé depuis 2 ordinateurs (portable + fixe) via GitHub, chacun avec sa propre session Claude Code. Tom ne tape pas les commandes git lui-même : **c'est à toi de le faire**, il ne devrait jamais avoir à y penser.

## Le rituel, à chaque session

**1. Au tout début, avant toute modification :** `git pull`

**2. Après chaque commit :** `git push`

**3. Si le push est rejeté** (`non-fast-forward` / « the remote contains work that you do not have ») : l'autre machine a poussé pendant ta session. Fais `git pull --rebase` puis `git push`. Ne force JAMAIS avec `--force`, ça écraserait le travail de l'autre machine.

> Le pull en début de session ne suffit pas : l'autre machine peut pousser **pendant** ta session. C'est déjà arrivé — 14 commits d'écart découverts au moment du push. Vérifie donc avant de pousser, pas seulement en arrivant.

## Ce qui n'est PAS synchronisé

Ne promets jamais à Tom que « tout est synchro » : ces éléments ne le sont pas et ne le seront pas.

- `tacotac-app/.env` — clés Stripe/OpenAI/Resend. Jamais dans git. Chaque machine et le VPS ont le leur.
- `node_modules/` — refaire `npm install` sur chaque machine.
- `tacotac-video/` — ancien dossier, ignoré par le `.gitignore`. À ne pas confondre avec `tacotac-video-pipeline/` (le vrai, versionné).
- Fichiers non suivis propres à chaque poste (`refs-videos/`, archives, notes…).

## Pièges connus

- **Ne jamais travailler sur les 2 machines en même temps** sur les mêmes fichiers : git ne peut pas trancher, ça finit en conflits à résoudre à la main.
- **Chemins différents selon la machine** : portable = `C:\Users\tomdu\Desktop\AGENT IA\tacotac`, fixe = `C:\Users\User\Desktop\tacotac`. Ne donne jamais un chemin en dur sans vérifier sur quelle machine tu es.
- **Le shell de Tom est PowerShell** : `&&` n'existe pas, utiliser `;`. Et préférer les slashs `/` aux antislashs dans les chemins (les `\` se font manger au copier-coller).
- **Identifiants GitHub** : la machine a 2 comptes en cache (`tomyafr` et `ecomindustrie`). Le remote de ce repo pointe sur `https://tomyafr@github.com/...` pour forcer le bon. Si un push renvoie « Permission denied to ecomindustrie » ou « Repository not found » sur un repo privé, c'est ce cache qui a basculé.
- **`.gitignore` racine ignore tous les `*.jpg`** — avec des exceptions explicites (personas de l'app, memes et photos du pipeline vidéo). Si tu ajoutes des images ailleurs, `git add` les ignorera **en silence**, sans erreur.

## Pipeline vidéo sur le VPS — attention

Le pipeline (`tacotac-video-pipeline/`) fait partie de ce repo, mais **sa copie sur le VPS (`/root/tacotac-video`) n'est PAS un dépôt git** : elle est déployée fichier par fichier en `scp`.

Conséquence : ne déploie jamais un fichier là-bas sans vérifier ce qu'il écrase. Tout le format POV (`PovVideo.tsx`, `generate-pov.ts`, `run-pov.sh`) n'existait QUE sur le VPS et a été cassé en écrasant `schema.ts` et `Root.tsx`. Il est depuis rapatrié dans le repo, mais le risque demeure pour tout autre fichier présent sur le VPS et absent d'ici.

L'app, elle (`/var/www/tacotac`), est bien un dépôt git : elle se met à jour par `git pull` via le skill de déploiement.

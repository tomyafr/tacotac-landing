# Pipeline auto — génération + rendu + upload (2×/jour)

Chaîne full-auto : Claude écrit le scénario (conv + disquettes en voix de marque) →
le code assemble les assets (fille au hasard, meme par beat) → Remotion rend le mp4 →
rclone envoie sur Drive. Prévu pour tourner sur le VPS Hostinger via cron.

## Génération : abonnement (défaut) ou API
- **Abonnement (défaut)** — passe par Claude Code (`claude -p`) et consomme **tes % Pro/Max**,
  pas de clé API ni de crédits. Il suffit d'être connecté (`claude login`).
- **API (option)** — `npx tsx pipeline/generate.ts 3 --api` + `ANTHROPIC_API_KEY` (facturé au token).

## Fichiers
- `generate.ts` — appelle Claude (`claude-opus-4-8`) + assemble + valide → écrit `queue/<id>.json`
- `run.sh` — orchestre : génère N, rend chaque scénario, upload Drive
- `queue/` — scénarios générés en attente de rendu
- `rendered/` — scénarios déjà rendus (archive)

## Prérequis VPS (une fois)

### 1. Node + le projet
```bash
# Node 20+ recommandé
cd ~/tacotac/tacotac-video
npm install --legacy-peer-deps      # (le SDK Claude a un peer zod souple)
npx remotion browser ensure          # télécharge le Chrome headless du render
```

### 2. Connexion Claude Code (abonnement)
```bash
npm install -g @anthropic-ai/claude-code   # installe la CLI `claude`
claude login                                # ouvre une URL à valider dans un navigateur
claude -p "dis ok"                           # test : doit répondre
```
> Sur un VPS sans écran, `claude login` affiche une URL à ouvrir sur n'importe quel
> navigateur (ton PC), puis tu colles le code retour. Aucune clé API nécessaire.
> Le token se rafraîchit seul ; reconnecte-toi si un run échoue sur l'auth.

### 3. rclone → Google Drive (upload)
```bash
sudo apt install rclone           # ou: curl https://rclone.org/install.sh | sudo bash
rclone config                     # crée un remote "gdrive" de type Google Drive (OAuth)
# teste :
rclone lsd gdrive:
```
Puis choisis le dossier Drive de destination, ex : `gdrive:tacotac-videos`.

### 4. Email de notif post-upload (optionnel mais recommandé)
Un email part **uniquement quand l'upload Drive est confirmé réussi** (jamais avant, jamais si rclone échoue) pour savoir quand les vidéos sont postables. Nécessite un `.env` à la racine du projet (jamais commité) :
```
RESEND_API_KEY=...       # même valeur que tacotac-app/.env (même compte Resend)
GIFT_FROM_EMAIL=Tacotac <hello@taco-tac.app>
NOTIFY_EMAIL=tomathieuia@gmail.com
```
Sans ce `.env`, le run continue normalement (l'upload n'est jamais bloqué), juste sans email.

## Lancer à la main
```bash
export TACOTAC_BATCH=3                        # nb de vidéos par run
export RCLONE_REMOTE="gdrive:tacotac-videos"  # destination (optionnel)
bash pipeline/run.sh                          # génération via ton abonnement
```
Générer seulement (sans rendre), pour relire les JSON :
```bash
npx tsx pipeline/generate.ts 3
# → inspecte pipeline/queue/*.json
```

## Cron 2×/jour
`crontab -e` puis (10h et 18h, heure du VPS) :
```cron
TACOTAC_BATCH=3
RCLONE_REMOTE=gdrive:tacotac-videos
0 10 * * * cd /home/USER/tacotac/tacotac-video && bash pipeline/run.sh
0 18 * * * cd /home/USER/tacotac/tacotac-video && bash pipeline/run.sh
```
Les logs de chaque run : `pipeline/run-<date>.log`.

## Ce que le code garantit
- Voix de marque : le `system_prompt_tacotac.md` est injecté tel quel ; nettoyage auto du point final.
- Structure : sortie **JSON structuré** (Claude ne peut pas dévier du format) + validation **zod** (`scriptSchema`) → tout scénario invalide est rejeté, jamais rendu.
- Assets : le modèle ne choisit PAS les fichiers ; le code pioche fille + memes (par beat) → zéro chemin cassé.
- Anti-répétition : storyReply / outroText / archétype de conversation tournent sur un pool (jamais de doublon avant de l'avoir épuisé), même mécanique que la rotation des filles.
- Tons vidéo limités à classe/spicy/sexto/romantique (pas drôle ni mystère — jugé moins viral).
- Sécurité snap : tout pseudo écrit par le modèle est encadré `[[SNAP:...]]` et flouté par une barre au rendu (jamais affiché en clair), voir `src/components/maskedText.tsx`.
- Musique : piste complète en fond sur toute la vidéo (loop si besoin), fondu de sortie sur la dernière seconde — jamais de coupure nette ni de silence.

## À régler avant la prod
- **Qualité des screenshots** : ré-exporter les 6 screens Tacotac en pleine résolution (voir note dans le chat).
- **Variété memes** : le beat `feu_vert` n'a qu'un meme ; en ajouter renforce la variété.

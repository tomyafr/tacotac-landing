#!/usr/bin/env bash
# Orchestrateur full-auto : génère N scénarios → rend chaque .mp4 → upload Drive.
# Prévu pour tourner sur le VPS via cron, 2x/jour.
#
# La génération passe par Claude Code (`claude -p`) = TON ABONNEMENT (tes %),
# pas de clé API. Il faut donc être connecté sur le VPS via `claude login`.
#
# Variables d'environnement (voir pipeline/README.md) :
#   TACOTAC_BATCH       nombre de vidéos par run (défaut 3)
#   RCLONE_REMOTE       destination rclone, ex "gdrive:tacotac-videos" (optionnel)
#   CLAUDE_BIN          chemin du binaire claude si introuvable automatiquement

# ── Environnement cron-safe ─────────────────────────────────────────────────
# cron démarre avec un PATH minimal (/usr/bin:/bin) et sans HOME garanti :
# `claude`, `npx` et `rclone` deviennent introuvables et l'auth Claude échoue.
# On reconstruit un environnement complet AVANT toute commande.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export HOME="${HOME:-/root}"
[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"

cd "$(dirname "$0")/.." || exit 1   # -> tacotac-video/
BATCH="${TACOTAC_BATCH:-3}"
STAMP="$(date +%Y%m%d-%H%M)"
DATE_HUMAN="$(date +%Y-%m-%d-%Hh%M)"  # utilisé pour nommer les mp4 uploadés (lisible dans Drive)
# Profil = compte destinataire (ex "solene"). Chaque profil a sa file d'attente, son
# dossier de sortie et sa rotation → jamais les mêmes vidéos qu'un autre profil.
# Sans TACOTAC_PROFILE : chemins d'origine, comportement inchangé.
PROFILE="$(printf '%s' "${TACOTAC_PROFILE:-}" | tr -cd 'a-zA-Z0-9_-')"
SUFFIX="${PROFILE:+-$PROFILE}"
QUEUE_DIR="pipeline/queue$SUFFIX"
RENDERED_DIR="pipeline/rendered$SUFFIX"
OUT_DIR="out$SUFFIX"
mkdir -p "$QUEUE_DIR" "$RENDERED_DIR" "$OUT_DIR"
LOG="pipeline/run$SUFFIX-$STAMP.log"
exec > >(tee -a "$LOG") 2>&1

# NOTE: pas de `set -e` — une génération qui échoue (quota, token expiré) ne doit
# PAS empêcher de rendre/uploader les scénarios déjà en file d'attente.
set -uo pipefail

echo "=== RUN $STAMP — batch=$BATCH${PROFILE:+ — profil=$PROFILE} ==="
echo "PATH=$PATH"
echo "HOME=$HOME"

# ── Diagnostic des dépendances (visible dans le log en cas de souci) ────────
fail=0
for bin in node npx; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "✓ $bin -> $(command -v "$bin")"
  else
    echo "✗ $bin INTROUVABLE"; fail=1
  fi
done
CLAUDE="${CLAUDE_BIN:-}"
if [ -z "$CLAUDE" ]; then
  for cand in "$(command -v claude 2>/dev/null)" /usr/local/bin/claude /usr/bin/claude \
              "$HOME/.npm-global/bin/claude" "$HOME/.local/bin/claude"; do
    [ -n "$cand" ] && [ -x "$cand" ] && CLAUDE="$cand" && break
  done
fi
if [ -n "$CLAUDE" ]; then
  echo "✓ claude -> $CLAUDE"
  export CLAUDE_BIN="$CLAUDE"
else
  echo "✗ claude INTROUVABLE — la génération va échouer (installe-le ou définis CLAUDE_BIN)"
  fail=1
fi
if [ "$fail" -ne 0 ]; then
  echo "⚠️ dépendances manquantes, on tente quand même la suite"
fi

# 1) Génération des scénarios (JSON validés dans pipeline/queue/)
echo "--- génération ($BATCH) ---"
if npx tsx pipeline/generate.ts "$BATCH"; then
  echo "génération OK"
else
  echo "⚠️ génération en échec (voir erreur ci-dessus) — on rend quand même la file existante"
fi

# 2) Rendu de chaque scénario en file d'attente — renommé en sortie avec un nom
# lisible (video-DATE-HEURE-N-a-poster.mp4) plutôt que l'id technique vid_<timestamp>,
# pour s'y retrouver direct dans Drive.
shopt -s nullglob
rendered=0
uploaded_names=()
for props in "$QUEUE_DIR"/*.json; do
  id="$(basename "$props" .json)"
  raw_out="$OUT_DIR/${id}.mp4"
  echo "--- render $id ---"
  if npx remotion render MasterVideo "$raw_out" --props="$props"; then
    rendered=$((rendered + 1))
    friendly_name="video-${DATE_HUMAN}-${rendered}-a-poster.mp4"
    friendly_out="$OUT_DIR/${friendly_name}"
    mv "$raw_out" "$friendly_out"
    mv "$props" "$RENDERED_DIR/"
    uploaded_names+=("$friendly_name")
    echo "OK $friendly_out"
  else
    echo "ÉCHEC render $id (le scénario reste en queue)"
  fi
done
echo "rendus: $rendered"

# 3) Upload Drive (si rclone configuré) — l'email de notif ne part QUE si l'upload
# est confirmé réussi (jamais avant, jamais si rclone échoue).
if [ -n "${RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "--- upload -> $RCLONE_REMOTE ---"
    # --stats-one-line : pas de barre de progression illisible dans les logs cron
    # --max-depth 1 : ne descend PAS dans le dossier d'archive créé plus bas.
    if rclone copy "$OUT_DIR/" "$RCLONE_REMOTE" --include "video-*-a-poster.mp4" --max-depth 1 --stats-one-line --stats 10s; then
      echo "upload terminé"
      # Une fois envoyées, on SORT les vidéos de $OUT_DIR. Sans ça, `rclone copy`
      # renvoie à chaque run tout ce qui manque à destination : les vidéos que Tom
      # supprimait du Drive revenaient donc systématiquement au run suivant (et la
      # purge ci-dessous ne servait à rien, elle était annulée dans la foulée).
      # Les fichiers restent sur le VPS comme sauvegarde, juste hors de portée du copy.
      ARCHIVE_DIR="${OUT_DIR}-envoyees"
      mkdir -p "$ARCHIVE_DIR"
      moved=0
      for sent in "$OUT_DIR"/video-*-a-poster.mp4; do
        [ -e "$sent" ] || continue
        mv "$sent" "$ARCHIVE_DIR/" && moved=$((moved + 1))
      done
      echo "archivées hors du dossier d'upload : $moved"
      # Purge des vieilles vidéos du Drive — sinon le quota finit par saturer et
      # PLUS AUCUN upload ne passe (arrivé le 08/08/26 : 11 vidéos bloquées).
      # ⚠️ Suppression DÉFINITIVE (--drive-use-trash=false) : sans ça les fichiers
      # partent à la corbeille, qui compte encore dans le quota Google — donc
      # zéro place récupérée. Le filtre --include ne vise QUE les fichiers produits
      # par ce pipeline : rien d'autre sur le Drive ne peut être touché.
      # Mettre DRIVE_RETENTION_DAYS=0 pour désactiver la purge.
      retention="${DRIVE_RETENTION_DAYS:-14}"
      if [ "$retention" != "0" ]; then
        echo "--- purge Drive : vidéos de +${retention}j ---"
        rclone delete "$RCLONE_REMOTE" --min-age "${retention}d" \
          --include "video-*-a-poster.mp4" --include "vid_*.mp4" \
          --drive-use-trash=false --stats-one-line \
          && echo "purge OK" || echo "⚠️ purge Drive en échec (sans conséquence sur les vidéos du jour)"
      fi
      if [ "${#uploaded_names[@]}" -gt 0 ]; then
        node pipeline/notify.mjs "${uploaded_names[@]}" || echo "⚠️ email de notif non envoye (upload OK quand meme)"
        # Publication TikTok — après l'upload Drive, pour qu'un échec de posting
        # ne fasse jamais perdre les vidéos (elles sont déjà sauvegardées).
        echo "--- publication TikTok ---"
        tiktok_paths=()
        for name in "${uploaded_names[@]}"; do tiktok_paths+=("$OUT_DIR/$name"); done
        node pipeline/tiktok-post.mjs "${tiktok_paths[@]}" || echo "⚠️ publication TikTok en échec (vidéos bien sur Drive)"
      fi
    else
      echo "⚠️ ÉCHEC upload rclone (mp4 conservés dans out/) — pas d'email envoyé"
    fi
  else
    echo "✗ rclone introuvable — pas d'upload"
  fi
else
  echo "RCLONE_REMOTE non défini — pas d'upload (mp4 dans out/)"
fi

echo "=== FIN $STAMP ==="

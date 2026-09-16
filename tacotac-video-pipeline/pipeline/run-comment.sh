#!/usr/bin/env bash
# Orchestrateur du 3e format ("commentaire") : génère la conv à partir d'UN
# commentaire réel → rend l'unique .mp4 → upload Drive → notifie.
# Même logique que run.sh/run-pov.sh (dont il reprend l'environnement
# cron-safe), mais traite TOUJOURS un seul commentaire à la fois — déclenché
# à la demande par le bouton "Générer" de /partner (voir tacotac-app/partner.js),
# jamais par cron. File d'attente / sorties séparées (queue-comment*, out-comment*)
# pour ne jamais interférer avec les 2 autres formats. Fichiers nommés "com-..."
# (run.sh n'uploade que "video-*", run-pov.sh que "pov-*", et inversement).
#
# Variables d'environnement :
#   COMMENT_USERNAME  pseudo TikTok de l'auteur du commentaire (obligatoire)
#   COMMENT_TEXT      texte du commentaire (obligatoire)
#   COMMENT_IMAGE     chemin de la capture dans public/, ex "comments/xxx.png" (obligatoire)
#   TACOTAC_PROFILE   profil destinataire ("anomy" = collab ; vide = Tom)
#   RCLONE_REMOTE     destination rclone, ex "gdrive:tacotac-videos" (optionnel)
#   CLAUDE_BIN        chemin du binaire claude si introuvable automatiquement

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export HOME="${HOME:-/root}"
[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"

cd "$(dirname "$0")/.." || exit 1   # -> tacotac-video/

if [ -z "${COMMENT_USERNAME:-}" ] || [ -z "${COMMENT_TEXT:-}" ] || [ -z "${COMMENT_IMAGE:-}" ]; then
  echo "✗ COMMENT_USERNAME / COMMENT_TEXT / COMMENT_IMAGE requis" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M)"
DATE_HUMAN="$(date +%Y-%m-%d-%Hh%M)"
PROFILE="$(printf '%s' "${TACOTAC_PROFILE:-}" | tr -cd 'a-zA-Z0-9_-')"
SUFFIX="${PROFILE:+-$PROFILE}"
QUEUE_DIR="pipeline/queue-comment$SUFFIX"
RENDERED_DIR="pipeline/rendered-comment$SUFFIX"
OUT_DIR="out-comment$SUFFIX"
mkdir -p "$QUEUE_DIR" "$RENDERED_DIR" "$OUT_DIR"
LOG="pipeline/run-comment$SUFFIX-$STAMP.log"
exec > >(tee -a "$LOG") 2>&1

# Pas de `set -e` (comme run.sh/run-pov.sh) : une étape ratée ne doit pas
# empêcher le reste (ex: upload malgré un souci de purge Drive).
set -uo pipefail

echo "=== RUN COMMENT $STAMP${PROFILE:+ — profil=$PROFILE} — @${COMMENT_USERNAME} ==="

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
[ "$fail" -ne 0 ] && echo "⚠️ dépendances manquantes, on tente quand même la suite"

# 1) Génération de la conv (JSON validé dans queue-comment*/)
echo "--- génération ---"
if npx tsx pipeline/generate-comment.ts --username="$COMMENT_USERNAME" --text="$COMMENT_TEXT" --image="$COMMENT_IMAGE"; then
  echo "génération OK"
else
  echo "⚠️ génération en échec"
fi

# 2) Rendu
shopt -s nullglob
rendered=0
uploaded_names=()
for props in "$QUEUE_DIR"/*.json; do
  id="$(basename "$props" .json)"
  raw_out="$OUT_DIR/${id}.mp4"
  echo "--- render $id ---"
  if npx remotion render MasterVideo "$raw_out" --props="$props"; then
    rendered=$((rendered + 1))
    friendly_name="com-${DATE_HUMAN}-${rendered}-a-poster.mp4"
    mv "$raw_out" "$OUT_DIR/${friendly_name}"
    mv "$props" "$RENDERED_DIR/"
    uploaded_names+=("$friendly_name")
    echo "OK $OUT_DIR/${friendly_name}"
  else
    echo "ÉCHEC render $id (le scénario reste en queue)"
  fi
done
echo "rendus: $rendered"

# 3) Upload Drive — l'email de notif ne part QUE si l'upload est confirmé réussi.
if [ -n "${RCLONE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "--- upload -> $RCLONE_REMOTE ---"
    if rclone copy "$OUT_DIR/" "$RCLONE_REMOTE" --include "com-*-a-poster.mp4" --max-depth 1 --stats-one-line --stats 10s; then
      echo "upload terminé"
      # Même correctif que run.sh/run-pov.sh : on sort les vidéos envoyées du
      # dossier d'upload, sinon `rclone copy` les remonte à chaque run.
      ARCHIVE_DIR="${OUT_DIR}-envoyees"
      mkdir -p "$ARCHIVE_DIR"
      moved=0
      for sent in "$OUT_DIR"/com-*-a-poster.mp4; do
        [ -e "$sent" ] || continue
        mv "$sent" "$ARCHIVE_DIR/" && moved=$((moved + 1))
      done
      echo "archivées hors du dossier d'upload : $moved"
      retention="${DRIVE_RETENTION_DAYS:-14}"
      if [ "$retention" != "0" ]; then
        echo "--- purge Drive : commentaire de +${retention}j ---"
        rclone delete "$RCLONE_REMOTE" --min-age "${retention}d" \
          --include "com-*-a-poster.mp4" \
          --drive-use-trash=false --stats-one-line \
          && echo "purge OK" || echo "⚠️ purge Drive en échec (sans conséquence sur la vidéo du jour)"
      fi
      if [ "${#uploaded_names[@]}" -gt 0 ]; then
        # NOTIFY_OUT_DIR : notify.mjs tourne APRÈS l'archivage, il doit donc
        # savoir où retrouver le mp4 pour pouvoir le joindre (NOTIFY_ATTACH=1, Anomy).
        NOTIFY_OUT_DIR="$OUT_DIR" node pipeline/notify.mjs "${uploaded_names[@]}" || echo "⚠️ email de notif non envoye (upload OK quand meme)"
      fi
    else
      echo "⚠️ ÉCHEC upload rclone (mp4 conservé dans $OUT_DIR/) — pas d'email envoyé"
    fi
  else
    echo "✗ rclone introuvable — pas d'upload"
  fi
else
  echo "RCLONE_REMOTE non défini — pas d'upload (mp4 dans $OUT_DIR/)"
fi

echo "=== FIN COMMENT $STAMP ==="

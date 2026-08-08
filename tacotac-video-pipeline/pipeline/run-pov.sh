#!/usr/bin/env bash
# Orchestrateur du 2e format ("POV meme") : génère N textes → rend chaque .mp4 → upload Drive.
# Même logique que run.sh (dont il reprend l'environnement cron-safe), mais :
#   - compo Remotion "PovVideo" au lieu de "MasterVideo"
#   - file d'attente / sorties séparées (queue-pov*, out-pov*) pour ne jamais
#     interférer avec les vidéos "conversation" déjà en place
#   - fichiers nommés "pov-..." (le run.sh n'uploade que "video-*", et inversement)
#
# Variables d'environnement :
#   TACOTAC_PROFILE   profil destinataire ("solene" = audience filles ; vide = Tom)
#   TACOTAC_BATCH     nombre de vidéos par run (défaut 2)
#   RCLONE_REMOTE     destination rclone, ex "gdrive:tacotac-videos" (optionnel)
#   CLAUDE_BIN        chemin du binaire claude si introuvable automatiquement

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export HOME="${HOME:-/root}"
[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"

cd "$(dirname "$0")/.." || exit 1   # -> tacotac-video/
BATCH="${TACOTAC_BATCH:-2}"
STAMP="$(date +%Y%m%d-%H%M)"
DATE_HUMAN="$(date +%Y-%m-%d-%Hh%M)"
PROFILE="$(printf '%s' "${TACOTAC_PROFILE:-}" | tr -cd 'a-zA-Z0-9_-')"
SUFFIX="${PROFILE:+-$PROFILE}"
QUEUE_DIR="pipeline/queue-pov$SUFFIX"
RENDERED_DIR="pipeline/rendered-pov$SUFFIX"
OUT_DIR="out-pov$SUFFIX"
mkdir -p "$QUEUE_DIR" "$RENDERED_DIR" "$OUT_DIR"
LOG="pipeline/run-pov$SUFFIX-$STAMP.log"
exec > >(tee -a "$LOG") 2>&1

# Pas de `set -e` (comme run.sh) : une génération ratée ne doit pas empêcher de
# rendre/uploader ce qui est déjà en file d'attente.
set -uo pipefail

echo "=== RUN POV $STAMP — batch=$BATCH${PROFILE:+ — profil=$PROFILE} ==="

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

# 1) Génération des textes POV (JSON validés dans queue-pov*/)
echo "--- génération ($BATCH) ---"
if npx tsx pipeline/generate-pov.ts "$BATCH"; then
  echo "génération OK"
else
  echo "⚠️ génération en échec — on rend quand même la file existante"
fi

# 2) Rendu
shopt -s nullglob
rendered=0
uploaded_names=()
for props in "$QUEUE_DIR"/*.json; do
  id="$(basename "$props" .json)"
  raw_out="$OUT_DIR/${id}.mp4"
  echo "--- render $id ---"
  if npx remotion render PovVideo "$raw_out" --props="$props"; then
    rendered=$((rendered + 1))
    friendly_name="pov-${DATE_HUMAN}-${rendered}-a-poster.mp4"
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
    if rclone copy "$OUT_DIR/" "$RCLONE_REMOTE" --include "pov-*-a-poster.mp4" --stats-one-line --stats 10s; then
      echo "upload terminé"
      # Purge des vieux POV du Drive — même logique que run.sh (quota Google saturé
      # = plus aucun upload). Suppression DÉFINITIVE, sinon la corbeille garde la place.
      # Ne vise QUE les fichiers pov-* de ce pipeline. DRIVE_RETENTION_DAYS=0 pour désactiver.
      retention="${DRIVE_RETENTION_DAYS:-14}"
      if [ "$retention" != "0" ]; then
        echo "--- purge Drive : POV de +${retention}j ---"
        rclone delete "$RCLONE_REMOTE" --min-age "${retention}d" \
          --include "pov-*-a-poster.mp4" \
          --drive-use-trash=false --stats-one-line \
          && echo "purge OK" || echo "⚠️ purge Drive en échec (sans conséquence sur les vidéos du jour)"
      fi
      if [ "${#uploaded_names[@]}" -gt 0 ]; then
        node pipeline/notify.mjs "${uploaded_names[@]}" || echo "⚠️ email de notif non envoye (upload OK quand meme)"
      fi
    else
      echo "⚠️ ÉCHEC upload rclone (mp4 conservés dans $OUT_DIR/) — pas d'email envoyé"
    fi
  else
    echo "✗ rclone introuvable — pas d'upload"
  fi
else
  echo "RCLONE_REMOTE non défini — pas d'upload (mp4 dans $OUT_DIR/)"
fi

echo "=== FIN POV $STAMP ==="

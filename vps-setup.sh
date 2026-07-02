#!/bin/bash
# ══════════════════════════════════════════════════════
#  TACOTAC — Setup auto-deploy VPS
#  Colle ce script dans ton terminal SSH sur le VPS
# ══════════════════════════════════════════════════════

set -e

REPO="https://github.com/tomyafr/tacotac-landing.git"
WEBROOT="/var/www/tacotac"

echo "━━━ 1. Dépendances ━━━"
apt-get update -q && apt-get install -y -q git curl

echo "━━━ 2. Clone ou pull ━━━"
if [ -d "$WEBROOT/.git" ]; then
  echo "Repo déjà cloné → git pull"
  cd "$WEBROOT" && git pull origin main
else
  echo "Nouveau clone → $WEBROOT"
  # Sauvegarde les images déjà présentes sur le VPS
  mkdir -p /tmp/tacotac-backup
  [ -f "$WEBROOT/renard-removebg-preview.png" ]              && cp "$WEBROOT/renard-removebg-preview.png"              /tmp/tacotac-backup/
  [ -f "$WEBROOT/renard_classe_lunette-removebg-preview.png" ] && cp "$WEBROOT/renard_classe_lunette-removebg-preview.png" /tmp/tacotac-backup/
  [ -f "$WEBROOT/renard_chill-removebg-preview.png" ]        && cp "$WEBROOT/renard_chill-removebg-preview.png"        /tmp/tacotac-backup/
  [ -f "$WEBROOT/renard_dragueur-removebg-preview.png" ]     && cp "$WEBROOT/renard_dragueur-removebg-preview.png"     /tmp/tacotac-backup/

  rm -rf "$WEBROOT"
  git clone "$REPO" "$WEBROOT"

  # Restaure les images si elles n'étaient pas dans le repo
  for f in /tmp/tacotac-backup/*.png; do
    [ -f "$f" ] && cp -n "$f" "$WEBROOT/" && echo "Restauré: $(basename $f)"
  done
fi

echo "━━━ 3. Permissions ━━━"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || chown -R root:root "$WEBROOT"
chmod -R 755 "$WEBROOT"

echo "━━━ 4. Script de déploiement ━━━"
cat > /usr/local/bin/tacotac-deploy.sh << 'DEPLOY'
#!/bin/bash
cd /var/www/tacotac
git pull origin main >> /var/log/tacotac-deploy.log 2>&1
chown -R www-data:www-data /var/www/tacotac 2>/dev/null || true
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deploy OK" >> /var/log/tacotac-deploy.log
DEPLOY
chmod +x /usr/local/bin/tacotac-deploy.sh

echo "━━━ 5. Cron (git pull toutes les 2 min) ━━━"
(crontab -l 2>/dev/null | grep -v tacotac-deploy; echo "*/2 * * * * /usr/local/bin/tacotac-deploy.sh") | crontab -
echo "Cron installé :"
crontab -l | grep tacotac

echo "━━━ 6. Vérification fichiers ━━━"
ls -lh "$WEBROOT"/*.png "$WEBROOT"/index.html 2>/dev/null

echo ""
echo "✅ Setup terminé ! Le site se met à jour automatiquement toutes les 2 min après chaque git push."
echo "   Logs : tail -f /var/log/tacotac-deploy.log"

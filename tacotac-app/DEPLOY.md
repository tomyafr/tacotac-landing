# 🌮 Tacotac — SaaS (LP + app + IA)

MVP complet : landing page qui collecte des emails **+** une vraie app qui analyse
les screenshots avec **OpenAI GPT-4o-mini** et génère 3 répliques par ton.

```
tacotac-app/
├── server.js              # serveur Node (sert le site + endpoint IA /api/analyze)
├── package.json
├── .env.example           # → copie en .env et colle ta clé OpenAI
├── ecosystem.config.cjs   # config PM2 (garde le serveur en vie sur le VPS)
└── public/
    ├── index.html         # landing page (waitlist email + bouton "Essayer gratuitement")
    ├── app.html           # l'app (upload → IA → 3 répliques, 2 essais gratuits)
    └── assets/            # visuels du renard
```

## Comment ça marche

- **Landing** (`/`) : collecte les emails (waitlist Google Sheet, déjà en place) + un bouton **« Essayer gratuitement »** qui mène à l'app.
- **App** (`/app`) : l'utilisateur upload un screenshot → le serveur l'envoie à OpenAI GPT-4o-mini (vision) → 3 répliques par ton (classe / drôle / spicy). **2 analyses gratuites** (compteur localStorage), puis une pop-up demande l'email pour continuer.
- La **clé API reste côté serveur** (`.env`), jamais dans le HTML.
- Si la clé manque ou l'IA plante, l'app **dégrade proprement** avec des répliques de secours (la démo ne casse jamais).

---

## 1. Tester en local (sur ton PC)

```bash
cd tacotac-app
npm install
cp .env.example .env      # puis colle ta vraie clé dans .env
npm start
```

Ouvre http://localhost:3000 — sans clé, ça tourne quand même en mode « secours ».

## 2. Obtenir une clé OpenAI

1. Va sur **platform.openai.com** → crée un compte.
2. **Billing** → ajoute du crédit (GPT-4o-mini coûte ~0,001–0,002 $ par analyse, donc 10 $ = des milliers d'analyses).
3. **API Keys** → « Create new secret key » → copie la clé `sk-proj-…`.
4. Colle-la dans le fichier `.env` : `OPENAI_API_KEY=sk-proj-...`

## 3. Déployer sur ton VPS Hostinger

En SSH sur le VPS :

```bash
# 1) Node.js (si pas déjà installé)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 2) Récupérer le code
cd /var/www
git clone https://github.com/tomyafr/tacotac-landing.git tacotac-app   # ou upload le dossier
cd tacotac-app/tacotac-app          # ← si le dossier est dans le repo landing
npm install

# 3) Config secrète
cp .env.example .env
nano .env                            # colle ta clé OpenAI, sauve (Ctrl+O, Ctrl+X)

# 4) Lancer en permanence avec PM2
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                          # suis la ligne affichée pour le démarrage auto
```

L'app tourne maintenant sur le **port 3000**. Il reste à la rendre accessible sur `tacotac.app`.

### Reverse proxy Nginx (pour servir sur le port 80/443)

```nginx
# /etc/nginx/sites-available/tacotac
server {
    listen 80;
    server_name tacotac.app www.tacotac.app;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/tacotac /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# HTTPS gratuit avec Certbot
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d tacotac.app -d www.tacotac.app
```

## 4. Mises à jour

```bash
cd /var/www/tacotac-app/tacotac-app
git pull
npm install
pm2 restart tacotac
```

---

## Réglages utiles

- **Nombre d'essais gratuits** : `FREE_TRIES` dans `public/app.html` (défaut 2).
- **Modèle IA** : `MODEL` dans `server.js` (`gpt-4o-mini`). Passe à `gpt-4o` pour une qualité supérieure (plus cher), ou `gpt-4.1-nano` pour encore moins cher.
- **Ton du coach / style des répliques** : `SYSTEM_PROMPT` dans `server.js`.
- **Waitlist** : le webhook Google Apps Script est déjà branché (LP + pop-up de l'app).

> ⚠️ Le compteur « 2 essais » est côté navigateur (localStorage) — parfait pour un MVP, mais contournable. Pour une vraie limite anti-abus, il faudra plus tard un compte utilisateur + un quota côté serveur.

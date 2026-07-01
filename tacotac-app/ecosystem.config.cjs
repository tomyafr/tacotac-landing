// Config PM2 — garde le serveur Tacotac en vie et le relance au reboot du VPS.
// Lancement : pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'tacotac',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};

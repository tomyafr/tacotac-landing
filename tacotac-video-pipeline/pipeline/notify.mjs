/**
 * Email de notification "vidéos prêtes sur Drive" — envoyé UNIQUEMENT après un
 * upload rclone confirmé réussi (jamais avant, jamais si l'upload a échoué).
 * Appelé par run.sh : node pipeline/notify.mjs <nom-fichier-1> [nom-fichier-2] ...
 *
 * Nécessite un .env local (jamais commité) avec RESEND_API_KEY, GIFT_FROM_EMAIL,
 * NOTIFY_EMAIL — mêmes valeurs que tacotac-app/.env (même compte Resend).
 */
import "dotenv/config";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("notify.mjs : aucun fichier passé en argument, rien à notifier");
  process.exit(0); // pas une erreur bloquante pour run.sh
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.GIFT_FROM_EMAIL || "Tacotac <onboarding@resend.dev>";
const TO = process.env.NOTIFY_EMAIL;
const DRIVE_FOLDER_URL = process.env.DRIVE_FOLDER_URL || "";

if (!RESEND_API_KEY || RESEND_API_KEY.includes("a_remplir") || !TO) {
  console.warn("notify.mjs : RESEND_API_KEY ou NOTIFY_EMAIL manquant dans .env — email non envoyé (vidéos bien uploadées quand même)");
  process.exit(0);
}

const rows = files
  .map((f) => `<tr><td style="padding:6px 0;color:#F4EEE2;font-size:14px;">🎬 ${f}</td></tr>`)
  .join("");

const html = `<div style="background:#0b0b0b;padding:32px 14px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;">
    <div style="text-align:center;padding-bottom:20px;">
      <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-.3px;">Tacotac</div>
    </div>
    <div style="background:#161616;border:1px solid #262626;border-radius:20px;padding:32px 28px;color:#F4EEE2;">
      <h1 style="font-size:22px;margin:0 0 10px;text-align:center;color:#fff;">🎬 ${files.length} vidéo${files.length > 1 ? "s" : ""} prête${files.length > 1 ? "s" : ""} sur ton Drive</h1>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.6;margin:0 0 18px;text-align:center;">Confirmé : l'upload vers <b style="color:#fff;">tacotac-videos</b> est terminé. Tu peux les poster.</p>
      <table style="width:100%;border-collapse:collapse;background:#0d0d0d;border-radius:12px;padding:14px;">
        <tbody>${rows}</tbody>
      </table>
      ${DRIVE_FOLDER_URL ? `<div style="text-align:center;margin-top:22px;">
        <a href="${DRIVE_FOLDER_URL}" style="display:inline-block;background:#FF5C00;color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 26px;border-radius:14px;">Ouvrir le dossier Drive</a>
      </div>` : ""}
    </div>
    <p style="color:#6e6a66;font-size:11.5px;text-align:center;margin:18px 0 0;">Pipeline vidéo Tacotac · notification automatique post-upload</p>
  </div></div>`;

const r = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    from: FROM,
    to: TO,
    subject: `🎬 ${files.length} vidéo${files.length > 1 ? "s" : ""} sur ton Drive — prête${files.length > 1 ? "s" : ""} à poster`,
    html,
  }),
});

if (!r.ok) {
  console.error("notify.mjs : échec envoi email", r.status, await r.text().catch(() => ""));
  process.exit(0); // ne bloque jamais run.sh — l'upload a déjà réussi
}
console.log(`notify.mjs : email envoyé à ${TO} (${files.length} fichier(s))`);

/**
 * Email de notification des vidéos prêtes — envoyé UNIQUEMENT après un upload
 * rclone confirmé réussi (jamais avant, jamais si l'upload a échoué).
 * Appelé par run.sh : node pipeline/notify.mjs <nom-fichier-1> [nom-fichier-2] ...
 *
 * DEUX MODES :
 *  - par défaut : un simple lien vers le dossier Drive (Tom, Solène).
 *  - NOTIFY_ATTACH=1 : les vidéos sont JOINTES au mail, téléchargeables direct.
 *    Ajouté pour ANOMY, qui n'arrive pas à se connecter au Drive (compte iCloud).
 *
 * ⚠️ Limite de taille : iCloud refuse les mails de plus de ~20 Mo, et l'encodage
 * base64 gonfle les fichiers d'environ 33 %. On découpe donc en PLUSIEURS mails
 * plutôt que d'en envoyer un seul trop gros qui serait rejeté en silence.
 *
 * Nécessite un .env local (jamais commité) avec RESEND_API_KEY, GIFT_FROM_EMAIL,
 * NOTIFY_EMAIL — mêmes valeurs que tacotac-app/.env (même compte Resend).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("notify.mjs : aucun fichier passé en argument, rien à notifier");
  process.exit(0); // pas une erreur bloquante pour run.sh
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.GIFT_FROM_EMAIL || "Tacotac <onboarding@resend.dev>";
const TO = process.env.NOTIFY_EMAIL;
const DRIVE_FOLDER_URL = process.env.DRIVE_FOLDER_URL || "";
const ATTACH = process.env.NOTIFY_ATTACH === "1";
// Dossier où run.sh a laissé les mp4 (il les archive juste après l'upload, donc
// on accepte les deux emplacements).
const OUT_DIR = process.env.NOTIFY_OUT_DIR || "";

if (!RESEND_API_KEY || RESEND_API_KEY.includes("a_remplir") || !TO) {
  console.warn("notify.mjs : RESEND_API_KEY ou NOTIFY_EMAIL manquant dans .env — email non envoyé (vidéos bien uploadées quand même)");
  process.exit(0);
}

// Budget volontairement prudent : 11 Mo de vidéo ≈ 15 Mo une fois encodées en
// base64, ce qui passe chez tous les fournisseurs (iCloud plafonne vers 20 Mo).
const MAX_RAW_BYTES_PER_MAIL = 11 * 1024 * 1024;

function findFile(name) {
  const candidates = OUT_DIR
    ? [path.join(OUT_DIR, name), path.join(`${OUT_DIR}-envoyees`, name)]
    : [name];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const html = (names, part, total) => `<div style="background:#0b0b0b;padding:32px 14px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;">
    <div style="text-align:center;padding-bottom:20px;">
      <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-.3px;">Tacotac</div>
    </div>
    <div style="background:#161616;border:1px solid #262626;border-radius:20px;padding:32px 28px;color:#F4EEE2;">
      <h1 style="font-size:22px;margin:0 0 10px;text-align:center;color:#fff;">🎬 ${names.length} vidéo${names.length > 1 ? "s" : ""} prête${names.length > 1 ? "s" : ""} à poster</h1>
      <p style="color:#B5ABA0;font-size:15px;line-height:1.6;margin:0 0 18px;text-align:center;">
        ${ATTACH
          ? `${names.length > 1 ? "Elles sont" : "Elle est"} en pièce jointe : appuie dessus pour ${names.length > 1 ? "les" : "la"} télécharger.${total > 1 ? ` (mail ${part}/${total})` : ""}`
          : "Confirmé : l'upload vers le Drive est terminé. Tu peux les poster."}
      </p>
      <table style="width:100%;border-collapse:collapse;background:#0d0d0d;border-radius:12px;padding:14px;">
        <tbody>${names.map((f) => `<tr><td style="padding:6px 0;color:#F4EEE2;font-size:14px;">🎬 ${f}</td></tr>`).join("")}</tbody>
      </table>
      ${DRIVE_FOLDER_URL ? `<div style="text-align:center;margin-top:22px;">
        <a href="${DRIVE_FOLDER_URL}" style="display:inline-block;background:#FF5C00;color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 26px;border-radius:14px;">Ouvrir le dossier Drive</a>
      </div>` : ""}
    </div>
    <p style="color:#6e6a66;font-size:11.5px;text-align:center;margin:18px 0 0;">Pipeline vidéo Tacotac · notification automatique post-upload</p>
  </div></div>`;

async function send(names, attachments, part, total) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: TO,
      subject: `🎬 ${names.length} vidéo${names.length > 1 ? "s" : ""} à poster${total > 1 ? ` (${part}/${total})` : ""}`,
      html: html(names, part, total),
      ...(attachments.length ? { attachments } : {}),
    }),
  });
  if (!r.ok) {
    console.error("notify.mjs : échec envoi email", r.status, await r.text().catch(() => ""));
    return false;
  }
  return true;
}

// ── Mode lien simple : un seul mail, aucun fichier lu ──
if (!ATTACH) {
  const ok = await send(files, [], 1, 1);
  if (ok) console.log(`notify.mjs : email envoyé à ${TO} (${files.length} fichier(s))`);
  process.exit(0);
}

// ── Mode pièces jointes : on découpe en lots qui tiennent dans un mail ──
const lots = [];
let lot = { names: [], attachments: [], bytes: 0 };
for (const name of files) {
  const full = findFile(name);
  if (!full) {
    console.warn(`notify.mjs : ${name} introuvable sur le disque — listé sans pièce jointe`);
    lot.names.push(name);
    continue;
  }
  const size = fs.statSync(full).size;
  if (lot.attachments.length > 0 && lot.bytes + size > MAX_RAW_BYTES_PER_MAIL) {
    lots.push(lot);
    lot = { names: [], attachments: [], bytes: 0 };
  }
  lot.names.push(name);
  lot.attachments.push({ filename: name, content: fs.readFileSync(full).toString("base64") });
  lot.bytes += size;
}
if (lot.names.length) lots.push(lot);

let envoyes = 0;
for (let i = 0; i < lots.length; i++) {
  const ok = await send(lots[i].names, lots[i].attachments, i + 1, lots.length);
  if (ok) envoyes += lots[i].names.length;
}
console.log(`notify.mjs : ${envoyes}/${files.length} fichier(s) envoyés à ${TO} en ${lots.length} mail(s)`);

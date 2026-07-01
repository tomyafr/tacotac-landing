/**
 * ════════════════════════════════════════════════════════════════
 *  TACOTAC — Webhook waitlist → Google Sheet
 * ════════════════════════════════════════════════════════════════
 *
 *  DÉPLOIEMENT (à faire une seule fois) :
 *
 *  1. Va sur https://script.google.com → "Nouveau projet"
 *  2. Supprime le code par défaut, colle tout ce fichier
 *  3. Le SHEET_ID est déjà rempli (ton sheet Tacotac)
 *  4. Si tu veux un token secret, remplis SECRET_TOKEN ci-dessous
 *  5. Clic "Déployer" → "Nouvelle déploiement"
 *       › Type : Application Web
 *       › Exécuter en tant que : Moi
 *       › Accès : Tout le monde (anonyme)
 *  6. Autorise les permissions quand Google te le demande
 *  7. Copie l'URL de déploiement (commence par https://script.google.com/macros/s/…/exec)
 *  8. Dans index.html, remplace WEBHOOK_URL_ICI par cette URL
 *
 *  ⚠️  À chaque modification du code : "Déployer" → "Gérer les déploiements"
 *      → modifier la version (sinon l'ancienne version reste active)
 * ════════════════════════════════════════════════════════════════
 */

// ── CONFIG ─────────────────────────────────────────────────────
const SHEET_ID      = '1PpFhlTHgpcILyDazvL1rRSzNwIEKgK-vG14e2QyGfkk';
const SECRET_TOKEN  = ''; // laisser vide = pas de vérif
const NOTIF_EMAIL   = 'tomathieuia@gmail.com'; // ton email de notification
// ───────────────────────────────────────────────────────────────


// ── HELPERS ────────────────────────────────────────────────────

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim().toLowerCase());
}

function nowFR() {
  const d = new Date();
  const tz = 'Europe/Paris';
  const date = Utilities.formatDate(d, tz, 'dd/MM/yyyy');
  const time = Utilities.formatDate(d, tz, 'HH:mm');
  return { date, time };
}

function jsonResponse(payload, code) {
  const output = ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Email', 'Date', 'Heure', 'Source', 'IP']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#FF5C00').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
}

function ensureLogHeaders(logSheet) {
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(['Timestamp', 'Email', 'Status', 'IP']);
    logSheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#333333').setFontColor('#ffffff');
    logSheet.setFrozenRows(1);
  }
}

function addLog(logSheet, email, status, ip) {
  const { date, time } = nowFR();
  logSheet.appendRow([date + ' ' + time, email || '', status, ip || '']);
}

function emailExists(sheet, email) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false; // seulement header ou vide
  const emails = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const normalized = String(email).trim().toLowerCase();
  return emails.some(row => String(row[0]).trim().toLowerCase() === normalized);
}

function getIP(e) {
  // Apps Script ne donne pas l'IP directement, on fait de notre mieux
  try {
    if (e && e.parameter && e.parameter.ip) return e.parameter.ip;
    if (e && e.headers && e.headers['X-Forwarded-For']) return e.headers['X-Forwarded-For'].split(',')[0].trim();
  } catch(_) {}
  return 'N/A';
}


// ── GET : health check OU inscription via URL params ───────────
// Le browser convertit POST→GET au 302 de Apps Script, donc on gère tout ici.
function doGet(e) {
  const email = e.parameter && e.parameter.email ? e.parameter.email : null;
  if (!email) {
    return jsonResponse({ status: 'ok', message: 'Tacotac webhook actif' });
  }
  const source    = (e.parameter.source    || 'landing').trim();
  const timestamp = (e.parameter.timestamp || new Date().toISOString());
  const ip        = getIP(e);
  return handleSubscription(email, source, timestamp, ip);
}


// ── LOGIQUE D'INSCRIPTION (partagée GET + POST) ─────────────────
function handleSubscription(emailRaw, source, timestamp, ip) {
  const logSheet  = getSheet('Logs');
  const mainSheet = getSheet('Waitlist');
  let email = '';
  try {
    ensureLogHeaders(logSheet);
    ensureHeaders(mainSheet);

    email = String(emailRaw || '').trim().toLowerCase();

    if (!email || !isValidEmail(email)) {
      addLog(logSheet, email, 'invalid_email', ip);
      return jsonResponse({ status: 'error', message: 'Email invalide' });
    }

    if (emailExists(mainSheet, email)) {
      addLog(logSheet, email, 'duplicate', ip);
      return jsonResponse({ status: 'duplicate', message: 'Email déjà inscrit' });
    }

    const { date, time } = nowFR();
    mainSheet.appendRow([email, date, time, source || 'landing', ip]);
    addLog(logSheet, email, 'ok', ip);

    // ── Notification email ─────────────────────────────────────
    try {
      const total = mainSheet.getLastRow() - 1; // -1 pour l'en-tête
      MailApp.sendEmail({
        to: NOTIF_EMAIL,
        subject: '🦊 Nouveau inscrit Tacotac !',
        htmlBody:
          '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1A1A1A;color:#fff;border-radius:12px;padding:28px;">' +
          '<h2 style="color:#FF5C00;margin-top:0;">🦊 Nouvel inscrit sur la liste d\'attente</h2>' +
          '<table style="width:100%;border-collapse:collapse;">' +
          '<tr><td style="padding:8px 0;color:#9A9A9A;width:80px;">Email</td><td style="padding:8px 0;font-weight:700;">' + email + '</td></tr>' +
          '<tr><td style="padding:8px 0;color:#9A9A9A;">Date</td><td style="padding:8px 0;">' + date + ' à ' + time + '</td></tr>' +
          '<tr><td style="padding:8px 0;color:#9A9A9A;">Source</td><td style="padding:8px 0;">' + (source || 'landing') + '</td></tr>' +
          '<tr><td style="padding:8px 0;color:#9A9A9A;">Total</td><td style="padding:8px 0;color:#FF5C00;font-weight:700;">' + total + ' inscrits 🚀</td></tr>' +
          '</table>' +
          '<a href="https://docs.google.com/spreadsheets/d/' + SHEET_ID + '" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#FF5C00;color:#fff;text-decoration:none;border-radius:100px;font-weight:700;">Voir le Sheet →</a>' +
          '</div>',
      });
    } catch(mailErr) {
      // L'email a quand même été enregistré, l'erreur mail ne bloque pas
      addLog(logSheet, email, 'mail_error: ' + mailErr.message, ip);
    }

    return jsonResponse({ status: 'ok', message: 'Email enregistré' });

  } catch(err) {
    addLog(logSheet, email, 'server_error: ' + err.message, ip);
    return jsonResponse({ status: 'error', message: 'Erreur serveur' });
  }
}

// ── POST (fallback si le browser envoie vraiment un POST) ───────
function doPost(e) {
  const ip = getIP(e);
  let data = {};
  try {
    const raw = e.postData && e.postData.contents ? e.postData.contents : '{}';
    data = JSON.parse(raw);
  } catch(_) {}
  return handleSubscription(data.email, data.source, data.timestamp, ip);
}

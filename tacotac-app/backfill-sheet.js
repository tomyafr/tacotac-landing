// ══════════════════════════════════════════════════════════════
//  Rattrapage : envoie dans le Google Sheet tous les comptes déjà
//  créés (Google + email) avant que la capture Sheet existe.
//  Lancer UNE fois sur le VPS :  node backfill-sheet.js
//  (lecture seule sur la base, aucun risque pour l'app en cours)
// ══════════════════════════════════════════════════════════════

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBHOOK = 'https://script.google.com/macros/s/AKfycbzuCip2KWPlPw7kudrsvP2DuZ94-W6yw6aJ7c_HiSFZysXaPfsvG57uq6lhDsDpGYudtw/exec';

const db = new DatabaseSync(path.join(__dirname, 'tacotac.db'));

let accounts = [];
try {
  accounts = db.prepare('SELECT email, google_id, created_at FROM accounts ORDER BY created_at').all();
} catch {
  console.log('Aucune table "accounts" (personne ne s\'est encore inscrit).');
  process.exit(0);
}

const google = accounts.filter((a) => a.google_id);
const emailPw = accounts.filter((a) => !a.google_id);

console.log('════════ COMPTES INSCRITS ════════');
console.log('Total       :', accounts.length);
console.log('  via Google:', google.length);
console.log('  via email :', emailPw.length);
console.log('──────────────────────────────────');
for (const a of accounts) {
  const when = new Date(a.created_at * 1000).toLocaleString('fr-FR');
  console.log(`  ${a.google_id ? '🟢 Google' : '✉️  Email '}  ${a.email.padEnd(34)} ${when}`);
}
console.log('──────────────────────────────────');

console.log('\nEnvoi dans le Google Sheet…');
let ok = 0;
for (const a of accounts) {
  const source = a.google_id ? 'account-google' : 'account-email';
  const p = new URLSearchParams({ email: a.email, source, timestamp: new Date(a.created_at * 1000).toISOString() });
  try { await fetch(`${WEBHOOK}?${p}`); ok++; process.stdout.write('.'); }
  catch (e) { console.error('\n  échec pour', a.email, e.message); }
  await new Promise((r) => setTimeout(r, 300)); // on ménage Google Apps Script
}
console.log(`\n\n✅ ${ok}/${accounts.length} comptes envoyés dans le Sheet.`);
console.log('   (si des emails y étaient déjà : Sheet → Données → Nettoyer → Supprimer les doublons)');
db.close();

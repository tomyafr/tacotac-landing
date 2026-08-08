// Brand tokens Tacotac (identiques à tacotac-app/public/app.html)
export const brand = {
  orange: "#FF5C00",
  orangeHover: "#FF6A14",
  dark: "#0E0E0E",
  cream: "#F2EDE6",
} as const;

// Palette de la conv DM — échantillonnée sur les vraies vidéos de réf (refs-videos/)
// Fond noir pur, bulle violette (toi) à droite, bulle grise (elle) à gauche avec
// petit avatar rond affiché uniquement sur le dernier message d'une série (règle IG).
export const dm = {
  bg: "#000000",
  bubbleClient: "#8B25EE", // violet, côté toi
  bubbleGirl: "#2B2E33", // gris foncé, côté elle
  textPrimary: "#FFFFFF",
  storyThumbBorder: "#3A3A3C",
} as const;

// Tokens de l'écran "Tes répliques" — repris tels quels de tacotac-app/public/app.html
export const app = {
  bg: "#0A0A0A",
  headerBorder: "#1a1a1a",
  avatarBorder: "rgba(255,92,0,.8)",
  pillBg: "#141414",
  pillBorder: "#242424",
  pillActiveBorder: "rgba(255,92,0,.7)",
  pillActiveBg: "rgba(255,92,0,.1)",
  pillLabel: "#7a756f",
  badgePillText: "#FF7A33",
  badgePillBorder: "rgba(255,92,0,.35)",
  badgePillBg: "rgba(255,92,0,.07)",
  resultCardBg: "#141414",
  resultCardBorder: "#222222",
  bubbleBg: "#1c1c1c",
  bubbleBorder: "#2b2b2b",
  labelOrange: "#FF6F1F",
  replyText: "#F0EDE8",
  refaireBg: "#1a1a1a",
  refaireBorder: "#2a2a2a",
  refaireText: "#8a8580",
  mutedText: "#56524e",
} as const;

export const toneMeta = {
  classe: { emoji: "🎩", label: "Classe", locked: false },
  drole: { emoji: "😂", label: "Drôle", locked: false },
  spicy: { emoji: "🌶️", label: "Spicy", locked: false },
  romantique: { emoji: "🌹", label: "Romantique", locked: true },
  sexto: { emoji: "😈", label: "Sexto", locked: true },
  mystere: { emoji: "🎭", label: "Mystère", locked: true },
} as const;

export const fonts = {
  title: "'Bricolage Grotesque', system-ui, sans-serif",
  body: "'Space Grotesk', system-ui, sans-serif",
} as const;

// Format vidéo cible
export const video = {
  width: 1080,
  height: 1920,
  fps: 30,
} as const;

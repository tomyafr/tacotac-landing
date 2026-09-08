import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadBricolage } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as loadNotoColorEmoji } from "@remotion/google-fonts/NotoColorEmoji";

// Charge les vraies polices de marque (mêmes que l'app) pour un raccord parfait
// avec les screenshots. loadFont() injecte le @font-face au chargement du module ;
// on garde les familles 'Space Grotesk' / 'Bricolage Grotesque' déjà utilisées.
loadSpaceGrotesk();
loadBricolage();
// Le VPS de rendu n'a AUCUNE police emoji système (vérifié : 24 polices, zéro
// emoji — tout sortait en carré vide, d'où la règle ZÉRO EMOJI dans generate.ts).
// 'Noto Color Emoji' est chargée comme webfont (même mécanisme que les 2 polices
// ci-dessus, marche déjà en prod), donc dispo même sans rien installer sur le VPS.
// Utilisée en fallback CSS (voir theme.ts fonts.emoji) partout où un emoji peut
// apparaître dans du texte codé en dur (pas dans les messages générés par le
// modèle, qui restent ZÉRO EMOJI).
loadNotoColorEmoji();

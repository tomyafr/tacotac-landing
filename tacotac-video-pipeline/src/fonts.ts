import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadBricolage } from "@remotion/google-fonts/BricolageGrotesque";

// Charge les vraies polices de marque (mêmes que l'app) pour un raccord parfait
// avec les screenshots. loadFont() injecte le @font-face au chargement du module ;
// on garde les familles 'Space Grotesk' / 'Bricolage Grotesque' déjà utilisées.
loadSpaceGrotesk();
loadBricolage();

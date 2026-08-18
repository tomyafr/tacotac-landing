import React from "react";
import { AbsoluteFill } from "remotion";
import { dm, fonts } from "../theme";
import { Avatar } from "./Avatar";
import { MessageBubble } from "./MessageBubble";
import { StoryReply } from "./StoryReply";
import type { Girl } from "../schema";

// Un item du fil DM (message ou ligne de fin — rendue comme un message normal).
export type DMItem =
  | { kind: "msg"; from: "girl" | "client"; text: string }
  | { kind: "ending"; text: string };

// Vue DM plein écran, bande centrée verticalement (noir au-dessus/en-dessous,
// comme les vraies vidéos). AUCUNE animation de bulle : on affiche exactement les
// items passés. Le timing d'apparition est géré par DMScene (parent).
// La pile de messages s'accumule sur toute la vidéo (jamais réinitialisée).
// Au-delà de ces seuils on ne garde que la QUEUE la plus récente — comme un vrai
// scroll de chat — pour garantir que le dernier message n'est JAMAIS coupé en bas.
// Le bloc story disparaît dès que le début de la conv sort de la fenêtre visible.
const MAX_WITH_STORY = 4;
const MAX_WITHOUT_STORY = 7;

export const DMScreen: React.FC<{
  girl: Girl;
  storyReply?: string;
  items: DMItem[];
}> = ({ girl, storyReply, items }) => {
  const asBubble = (it: DMItem): { from: "girl" | "client"; text: string } =>
    it.kind === "ending" ? { from: "girl", text: it.text } : { from: it.from, text: it.text };

  // avatar calculé sur la liste COMPLÈTE (le "next" doit rester correct même si
  // l'item courant n'est visible qu'après fenêtrage)
  const showAvatarFor = (i: number): boolean => {
    if (asBubble(items[i]).from !== "girl") return false;
    const next = items[i + 1];
    return !next || asBubble(next).from !== "girl";
  };

  const fitsWithStory = items.length <= MAX_WITH_STORY;
  const showStory = fitsWithStory;
  const startIndex = fitsWithStory ? 0 : Math.max(0, items.length - MAX_WITHOUT_STORY);
  const visible = items.slice(startIndex).map((it, i) => ({ it, index: startIndex + i }));

  return (
    <AbsoluteFill style={{ background: dm.bg }}>
      {/* En-tête de conv persistant (avatar + nom + statut). Sans lui, le format DM
          à froid ouvrait sur une bulle SEULE sur fond noir dès que le faux bandeau
          "Vous avez répondu à sa story" a été retiré (il mentait — aucune story
          n'existe dans ce format) : ça recréait l'effet "fausse conv" que ce bandeau
          était censé éviter, juste sous une autre forme. Un vrai DM affiche toujours
          qui on écrit — c'est ce bloc qui porte cette info maintenant, honnêtement.
          Toujours là dès la 1re frame de la scène, jamais retardé. */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: 40,
          right: 40,
          display: "flex",
          alignItems: "center",
          gap: 18,
        }}
      >
        <Avatar name={girl.name} src={girl.avatar} size={64} />
        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 30, fontWeight: 700, color: dm.textPrimary }}>
            {girl.name}
          </div>
          <div style={{ fontFamily: fonts.body, fontSize: 22, color: "#8E8E93", marginTop: 2 }}>
            {girl.status}
          </div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 16,
          paddingBlock: 40,
          overflow: "hidden",
        }}
      >
        {/* Le bloc story ne s'affiche QUE s'il y a vraiment une réponse à une story
            (format A). En format DM à froid, storyReply est vide : on affichait
            quand même le bandeau "Vous avez répondu à sa story" + la vignette,
            alors qu'il n'a répondu à aucune story. Pire, le bloc apparaissait SEUL
            (sans bulle, puisque reply était vide) et son 1er message tombait 0,4 s
            plus tard en bulle séparée — d'où l'effet "fausse conv" vu par Tom. */}
        {storyReply && girl.storyThumbnail && showStory && (
          <StoryReply thumbnail={girl.storyThumbnail} reply={storyReply} />
        )}
        {visible.map(({ it, index }) => {
          const b = asBubble(it);
          return (
            <MessageBubble
              key={index}
              from={b.from}
              text={b.text}
              showAvatar={showAvatarFor(index)}
              girlName={girl.name}
              girlAvatarSrc={girl.avatar}
            />
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

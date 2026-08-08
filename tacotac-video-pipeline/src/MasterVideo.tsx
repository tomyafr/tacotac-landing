import React, { Fragment } from "react";
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { DMScene } from "./components/DMScene";
import { TacotacScreenshot } from "./components/TacotacScreenshot";
import { MemeOverlay } from "./components/MemeOverlay";
import { CaptionCard } from "./components/CaptionCard";
import { Intro } from "./components/Intro";
import { resolveMusic } from "./music";
import { buildScenes, FADE, type Scene } from "./timing";
import type { Script } from "./schema";

const renderScene = (script: Script, s: Scene) => {
  switch (s.kind) {
    case "intro":
      return <Intro caption={script.introCaption} trimFrames={s.trim} />;
    case "caption":
      return <CaptionCard text={s.text} background={s.background} variant={s.variant} />;
    case "dm":
      return <DMScene girl={script.girl} storyReply={script.storyReply} base={s.base} reveals={s.reveals} starts={s.starts} />;
    case "tacotac":
      return <TacotacScreenshot beat={s.beat} />;
    case "meme":
      return <MemeOverlay asset={s.asset} />;
  }
};

// Musique de fond — piste complète fournie par Tom (public/music/bg-music.m4a,
// voir reference/musique-complete.mov pour la source d'origine), sur TOUTE la
// durée du montage. `loop` la relance automatiquement si une vidéo dépasse sa
// longueur (~58s) ; fondu de sortie sur la DERNIÈRE SECONDE de la vidéo, quelle
// que soit sa durée totale (jamais de coupure nette, jamais de silence avant).
const MUSIC_FADE_OUT_SECONDS = 1;
const BackgroundMusic: React.FC<{ src: string }> = ({ src }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const fadeFrames = Math.round(fps * MUSIC_FADE_OUT_SECONDS);
  const volume = interpolate(
    frame,
    [durationInFrames - fadeFrames, durationInFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return <Audio src={staticFile(src)} loop volume={volume} />;
};

export const MasterVideo: React.FC<{ script: Script }> = ({ script }) => {
  const scenes = buildScenes(script);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <BackgroundMusic src={resolveMusic(script.music).file} />
      <TransitionSeries>
        {scenes.map((s, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <TransitionSeries.Transition
                presentation={fade()}
                timing={linearTiming({ durationInFrames: FADE })}
              />
            )}
            <TransitionSeries.Sequence durationInFrames={s.dur}>
              {renderScene(script, s)}
            </TransitionSeries.Sequence>
          </Fragment>
        ))}
      </TransitionSeries>
    </AbsoluteFill>
  );
};

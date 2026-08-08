import React from "react";
import { Composition } from "remotion";
import { MasterVideo } from "./MasterVideo";
import { totalDuration } from "./timing";
import { PovVideo, povDuration } from "./PovVideo";
import { TacotacScreenshot } from "./components/TacotacScreenshot";
import { scriptSchema, povScriptSchema, tacotacBeat, type Script, type PovScript } from "./schema";
import { video } from "./theme";
import vid001 from "./data/vid_001.json";

const script = scriptSchema.parse(vid001);

// Script POV d'exemple (studio uniquement) — la prod passe par --props.
const povDemo = povScriptSchema.parse({
  id: "pov_demo",
  povText: "pov : tu captes enfin pourquoi ton pote se prend jamais de vent et pas toi (tacotac)",
  hashtags: ["wshilavaitrienditlebg", "jeteparlepluslarry", "moijmecrameseul"],
  memes: [
    "memes/olise-chut.mp4",
    "memes/fr-peace-smug.jpg",
    "memes/larme-emotion.mp4",
    "memes/intelligent.jpg",
  ],
});
const tacotacBeatDemo = tacotacBeat.parse(
  script.beats.find((b) => b.type === "tacotac")
);

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Vidéo complète séquencée — durée calculée depuis le script */}
      <Composition
        id="MasterVideo"
        component={MasterVideo}
        fps={video.fps}
        width={video.width}
        height={video.height}
        defaultProps={{ script }}
        calculateMetadata={({ props }) => {
          const s = scriptSchema.parse((props as { script: Script }).script);
          return { durationInFrames: totalDuration(s) };
        }}
      />

      {/* Format POV — memes + texte "pov: ...", durée = 1s par meme */}
      <Composition
        id="PovVideo"
        component={PovVideo}
        fps={video.fps}
        width={video.width}
        height={video.height}
        defaultProps={{ script: povDemo }}
        calculateMetadata={({ props }) => {
          const s = povScriptSchema.parse((props as { script: PovScript }).script);
          return { durationInFrames: povDuration(s) };
        }}
      />

      {/* Compo de dev — itérer sur l'écran Tacotac isolé */}
      <Composition
        id="TacotacScreenDemo"
        component={TacotacScreenshot}
        durationInFrames={video.fps * 3}
        fps={video.fps}
        width={video.width}
        height={video.height}
        defaultProps={{ beat: tacotacBeatDemo }}
      />
    </>
  );
};

import "./index.css";
import React from "react";
import { Composition, CalculateMetadataFunction } from "remotion";
import { SplitShot } from "./SplitShot";
import { PortraitShot } from "./PortraitShot";
import {
  splitShotSchema,
  portraitShotSchema,
  SplitShotProps,
  PortraitShotProps,
} from "./types";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

// NOTE: source.src is a public/-relative path (e.g. "assets/mascot.mp4"),
// resolved via staticFile() inside CenterCropVideo.tsx -- not here. Renders
// driven by a JSON --props file (see remotion.jsh in SLICC) never go
// through this file, so staticFile() has to happen where the component
// actually reads the prop, not in these Studio-only defaults.

const calcSplitMetadata: CalculateMetadataFunction<SplitShotProps> = ({
  props,
}) => ({
  durationInFrames: Math.max(
    1,
    Math.round(props.durationInSeconds * FPS),
  ),
});

const calcPortraitMetadata: CalculateMetadataFunction<PortraitShotProps> = ({
  props,
}) => ({
  durationInFrames: Math.max(
    1,
    Math.round(props.durationInSeconds * FPS),
  ),
});

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="split"
        component={SplitShot}
        schema={splitShotSchema}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        durationInFrames={138}
        calculateMetadata={calcSplitMetadata}
        defaultProps={{
          durationInSeconds: 4.6,
          top: { src: "assets/mascot.mp4", inSec: 0 },
          bottom: { src: "assets/human.webm", inSec: 12.25 },
        }}
      />
      <Composition
        id="portrait-interviewer"
        component={PortraitShot}
        schema={portraitShotSchema}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        durationInFrames={138}
        calculateMetadata={calcPortraitMetadata}
        defaultProps={{
          durationInSeconds: 4.6,
          source: { src: "assets/mascot.mp4", inSec: 0 },
        }}
      />
      <Composition
        id="portrait-interviewee"
        component={PortraitShot}
        schema={portraitShotSchema}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        durationInFrames={70}
        calculateMetadata={calcPortraitMetadata}
        defaultProps={{
          durationInSeconds: 2.35,
          source: { src: "assets/human.webm", inSec: 12.25 },
        }}
      />
    </>
  );
};

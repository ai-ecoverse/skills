import React from "react";
import { AbsoluteFill } from "remotion";
import { CenterCropVideo } from "./CenterCropVideo";
import type { SplitShotProps } from "./types";

// Shot type 1: interviewer on top, interviewee on bottom.
// Both sources are landscape 16:9; each half is 1080x960 (9:8), so
// CenterCropVideo's object-fit:cover does the "crop to 9:8 then scale".
export const SplitShot: React.FC<SplitShotProps> = ({
  durationInSeconds,
  top,
  bottom,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ height: "50%", overflow: "hidden" }}>
        <CenterCropVideo source={top} durationInSeconds={durationInSeconds} />
      </AbsoluteFill>
      <AbsoluteFill style={{ top: "50%", height: "50%", overflow: "hidden" }}>
        <CenterCropVideo
          source={bottom}
          durationInSeconds={durationInSeconds}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

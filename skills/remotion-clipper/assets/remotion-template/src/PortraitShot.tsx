import React from "react";
import { AbsoluteFill } from "remotion";
import { CenterCropVideo } from "./CenterCropVideo";
import type { PortraitShotProps } from "./types";

// Shot types 2 & 3: a single source filling the full 1080x1920 frame.
// - portrait-interviewer: the mascot, already ~landscape -> cropped to 9:16.
// - portrait-interviewee: the human webcam, center-cropped to 9:16.
// Same component; the two composition ids just document intent for the EDL.
export const PortraitShot: React.FC<PortraitShotProps> = ({
  durationInSeconds,
  source,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black", overflow: "hidden" }}>
      <CenterCropVideo source={source} durationInSeconds={durationInSeconds} />
    </AbsoluteFill>
  );
};

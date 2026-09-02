import React from "react";
import { OffthreadVideo, staticFile, useVideoConfig } from "remotion";
import type { TrimmedSource } from "./types";

/**
 * Fills its parent box by center-cropping the source to the parent's
 * aspect ratio, then scaling to fill. object-fit: cover on a container
 * of the exact target size is mathematically identical to "center-crop
 * to target aspect, then scale" -- which is what the split (9:8 halves)
 * and portrait-interviewee (9:16) shots need.
 *
 * `source.src` is always a path relative to `public/` (e.g.
 * "assets/mascot.mp4") -- resolved here via `staticFile()` so both
 * Studio defaultProps AND `--props=file.json` CLI renders work the same
 * way. Renders driven by a JSON props file never go through JS, so they
 * can't call staticFile() themselves -- this is the one place it happens.
 */
export const CenterCropVideo: React.FC<{
  source: TrimmedSource;
  durationInSeconds: number;
}> = ({ source, durationInSeconds }) => {
  const { fps } = useVideoConfig();
  const trimBefore = Math.round(source.inSec * fps);
  const trimAfter = trimBefore + Math.round(durationInSeconds * fps);

  return (
    <OffthreadVideo
      src={staticFile(source.src)}
      trimBefore={trimBefore}
      trimAfter={trimAfter}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
      }}
    />
  );
};

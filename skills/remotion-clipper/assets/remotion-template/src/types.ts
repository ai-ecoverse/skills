import { z } from "zod";

// A single trim point into a source video: where playback starts.
// How long it plays is determined by the shot's `durationInSeconds`,
// so that multi-track shots (split) stay in sync by construction.
export const trimmedSourceSchema = z.object({
  src: z.string(),
  inSec: z.number().nonnegative(),
});
export type TrimmedSource = z.infer<typeof trimmedSourceSchema>;

export const splitShotSchema = z.object({
  durationInSeconds: z.number().positive(),
  top: trimmedSourceSchema,
  bottom: trimmedSourceSchema,
});
export type SplitShotProps = z.infer<typeof splitShotSchema>;

export const portraitShotSchema = z.object({
  durationInSeconds: z.number().positive(),
  source: trimmedSourceSchema,
});
export type PortraitShotProps = z.infer<typeof portraitShotSchema>;

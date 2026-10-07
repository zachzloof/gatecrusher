import { z } from "zod";

/** What the small gate window shows before (or instead of) the app. */
export const gateStateSchema = z.discriminatedUnion("mode", [
  /** First start of this build: ask for the access code. */
  z.object({ mode: z.literal("code"), contact: z.string() }),
  /** Code accepted; services are starting. */
  z.object({ mode: z.literal("starting"), step: z.string() }),
  /** The build is past its end date. */
  z.object({ mode: z.literal("expired"), expiredAt: z.string(), contact: z.string() }),
  /** Something stopped the app from starting. */
  z.object({ mode: z.literal("error"), message: z.string() }),
]);
export type GateState = z.infer<typeof gateStateSchema>;

/** The access code as typed: anything longer is not a code. */
export const submittedCodeSchema = z.string().max(200);

/**
 * A playlist folder name under downloads/: a slug as `playlistSlug` makes them
 * (lower-case letters, digits, dashes). Never a path.
 */
export const downloadsFolderSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/);

// Set per build you hand out. A new build with a new code makes everyone enter it again;
// a build past its expiry refuses to start and asks for the new installer.

/**
 * SHA-256 of the access code, after trimming and lower-casing it (see `normaliseCode`).
 * Only the hash is in the app, so the code is not sitting in it as plain text.
 * Current code: the one the owner hands out with this build.
 */
export const ACCESS_CODE_SHA256 =
  "61f03fd86cf96473775ba6980a142a8a1b6d8b0fb9ee2b856d774e45c0f97afe";

/** After this moment the build stops working. */
export const BUILD_EXPIRES_AT = "2026-12-07T23:59:59.000Z";

/** Shown on the expired and access screens: who to ask for a new installer or code. */
export const OWNER_CONTACT = "Zach";

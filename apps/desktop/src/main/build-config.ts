// Set per build you hand out. Each code has its own end date, or none. A machine that
// entered a code keeps running until that code's end date; after that (or on a build
// whose codes have all changed) the app asks for a code again.

export interface AccessCode {
  /** SHA-256 of the code, after trimming and lower-casing it (see `normaliseCode`). */
  sha256: string;
  /** After this moment the code stops working; `null` means it never does. */
  expiresAt: string | null;
}

/**
 * The codes this build accepts. Only hashes are in the app, so the codes are not sitting
 * in it as plain text. Make a hash with:
 *   node -e "console.log(require('crypto').createHash('sha256').update('the code'.trim().toLowerCase()).digest('hex'))"
 */
export const ACCESS_CODES: readonly AccessCode[] = [
  // The test code handed to friends, good for the test period.
  {
    sha256: "61f03fd86cf96473775ba6980a142a8a1b6d8b0fb9ee2b856d774e45c0f97afe",
    expiresAt: "2026-12-07T23:59:59.000Z",
  },
  // The owner's permanent code.
  {
    sha256: "5c82f3dd583968be672bcf3e7492d0eb24b2fdbbad176b3a05a964e6d9900821",
    expiresAt: null,
  },
];

/** Shown on the access screen: who to ask for a code. */
export const OWNER_CONTACT = "Zach";

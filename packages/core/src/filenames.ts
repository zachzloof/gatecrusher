// Pure naming rules for the downloads layout:
//   data/downloads/<playlist-slug>/<artist> - <title>.<ext>
// Track titles and artist names are untrusted text, so nothing here can produce a path
// separator, a parent-directory segment or a name Windows refuses.

const FORBIDDEN_CHARACTERS = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

/** Device names Windows reserves, with or without an extension. */
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const DEFAULT_PART_LENGTH = 100;
const SLUG_LENGTH = 80;

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** Leading dots would hide the file; trailing dots and spaces are dropped by Windows. */
function trimDotsAndSpaces(value: string): string {
  return value.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
}

/**
 * One safe file-name part from free text. Never empty, never longer than `maxLength`
 * characters, and never a path.
 */
export function sanitiseFileNamePart(value: string, maxLength = DEFAULT_PART_LENGTH): string {
  const cleaned = Array.from(value.normalize("NFC"), (character) =>
    FORBIDDEN_CHARACTERS.has(character) || isControlCharacter(character) ? " " : character,
  )
    .join("")
    .replace(/\s+/g, " ");

  const limited = trimDotsAndSpaces(
    Array.from(trimDotsAndSpaces(cleaned)).slice(0, maxLength).join(""),
  );
  if (limited === "") return "untitled";
  return RESERVED_WINDOWS_NAMES.test(limited) ? `_${limited}` : limited;
}

/** `<artist> - <title>`, without an extension. */
export function downloadBaseName(artist: string, title: string): string {
  return `${sanitiseFileNamePart(artist)} - ${sanitiseFileNamePart(title)}`;
}

/** The base name for the n-th file wanting the same name: `name`, `name (2)`, `name (3)`. */
export function withCollisionSuffix(baseName: string, attempt: number): string {
  return attempt <= 1 ? baseName : `${baseName} (${attempt})`;
}

function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      // Drop the combining marks NFKD split off, so "é" becomes "e" rather than "e-".
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_LENGTH)
      .replace(/-+$/, "")
  );
}

/**
 * The directory name for a playlist's downloads: the slug from its SoundCloud URL
 * (`/user/sets/<slug>`), falling back to its title.
 */
export function playlistSlug(soundcloudUrl: string, title: string): string {
  let fromUrl = "";
  if (URL.canParse(soundcloudUrl)) {
    const segments = new URL(soundcloudUrl).pathname.split("/").filter(Boolean);
    const setsIndex = segments.indexOf("sets");
    if (setsIndex !== -1) fromUrl = slugify(segments[setsIndex + 1] ?? "");
  }
  return fromUrl || slugify(title) || "playlist";
}

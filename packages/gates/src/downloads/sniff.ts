// Content sniffing from leading bytes. A file's name and the server's Content-Type are
// never trusted: an HTML error page saved as "track.mp3" must not count as a download.

export interface SniffedType {
  mimeType: string;
  /** Extension to store the file under, without the dot. */
  extension: string;
}

/** How many leading bytes `sniffAudio` needs at most. */
export const SNIFF_BYTES = 16;

const ascii = (bytes: Uint8Array, start: number, text: string): boolean => {
  if (bytes.length < start + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[start + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

/** ISO base media brands used for audio-only files and by common encoders. */
const MP4_AUDIO_BRANDS = ["M4A ", "M4B ", "mp42", "mp41", "isom", "iso2"];

/** An MPEG audio frame header: sync bits set, and no reserved version/layer/bitrate/rate. */
function isMpegAudioFrame(bytes: Uint8Array): boolean {
  const [first, second, third] = bytes;
  if (first === undefined || second === undefined || third === undefined) return false;
  return (
    first === 0xff &&
    (second & 0xe0) === 0xe0 &&
    (second & 0x18) !== 0x08 && // version: 01 is reserved
    (second & 0x06) !== 0x00 && // layer: 00 is reserved
    (third & 0xf0) !== 0xf0 && // bitrate: 1111 is invalid
    (third & 0x0c) !== 0x0c // sample rate: 11 is reserved
  );
}

/** The audio type the bytes start like, or `null` when they are not audio. */
export function sniffAudio(bytes: Uint8Array): SniffedType | null {
  if (ascii(bytes, 0, "ID3")) return { mimeType: "audio/mpeg", extension: "mp3" };
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) {
    return { mimeType: "audio/wav", extension: "wav" };
  }
  if (ascii(bytes, 0, "FORM") && (ascii(bytes, 8, "AIFF") || ascii(bytes, 8, "AIFC"))) {
    return { mimeType: "audio/aiff", extension: "aiff" };
  }
  if (ascii(bytes, 0, "fLaC")) return { mimeType: "audio/flac", extension: "flac" };
  if (ascii(bytes, 0, "OggS")) return { mimeType: "audio/ogg", extension: "ogg" };
  if (ascii(bytes, 4, "ftyp") && MP4_AUDIO_BRANDS.some((brand) => ascii(bytes, 8, brand))) {
    return { mimeType: "audio/mp4", extension: "m4a" };
  }
  // ADTS AAC: sync word with the layer bits at 00, which MPEG audio never has.
  if (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xf6) === 0xf0) {
    return { mimeType: "audio/aac", extension: "aac" };
  }
  if (isMpegAudioFrame(bytes)) return { mimeType: "audio/mpeg", extension: "mp3" };
  return null;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** A plain-words guess at what non-audio bytes are, for the failure reason. */
export function describeNonAudio(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 64)).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "an HTML page";
  if (head.startsWith("{") || head.startsWith("[")) return "a JSON document";
  if (head.startsWith("<?xml")) return "an XML document";
  return "not audio";
}

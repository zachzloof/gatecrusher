export type CsvCell = string | number | null | undefined;

/** Spreadsheets run a cell starting with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

function escapeCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";

  // Track titles are untrusted text that ends up in a spreadsheet: a leading apostrophe
  // makes the cell plain text instead of a formula (CSV injection).
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * RFC 4180 CSV: CRLF line endings, fields containing a comma, quote or line break are
 * quoted, quotes are doubled. Every row is padded or cut to the header's width.
 */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  const lines = [headers, ...rows.map((row) => headers.map((_, index) => row[index]))];
  return lines.map((line) => line.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}

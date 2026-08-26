/**
 * Parses the exact `sha256sum` output format `release-configs.yml`'s
 * `sha256sum * > SHA256SUMS.txt` step produces (Story 2.1): each line is
 * `<64-hex-char hash><space><mode char><filename>`, where the mode char
 * is a plain space for text mode or `*` for binary mode. Returns a map
 * from filename to lowercase hash. Malformed lines (wrong hash length,
 * missing separator, blank lines) are skipped rather than throwing --
 * callers treat "asset name not present in the map" the same whether the
 * line was absent or unparsable, which both fail closed via
 * `checkAndApply`'s verification step. Not a general GNU-coreutils
 * parser: the backslash-escaped filename convention `sha256sum` uses for
 * names containing a newline or backslash is not handled, since the
 * fixed asset names this project publishes never need it.
 */
const SHA256_LINE_PATTERN = /^([0-9a-fA-F]{64}) [ *](.+)$/;

export function parseSha256Sums(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      continue;
    }
    const match = SHA256_LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const hash = match[1];
    const filename = match[2];
    if (hash === undefined || filename === undefined) {
      continue;
    }
    result.set(filename, hash.toLowerCase());
  }
  return result;
}

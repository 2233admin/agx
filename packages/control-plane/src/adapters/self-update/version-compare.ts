/**
 * Fail-closed numeric version comparison: `.`-separated numeric fields,
 * compared segment by segment as numbers (so `1.2.0` < `1.10.0`, not the
 * string-order opposite). Returns `true` only when `remote` is strictly
 * greater than `current`.
 *
 * Deliberately conservative -- any ambiguity returns `false` ("not
 * newer") rather than `true`: either side has any non-digit segment (a
 * pre-release/build suffix like `1.2.0-rc1`, a stray letter, an empty
 * segment from `1..2` or from the empty string itself, etc).
 *
 * This is the one place the self-update chain decides "is there actually
 * something to update to" -- see Spec Change Log: naively treating "tag
 * differs from CONFIGS_VERSION" as "has an update" lets the release
 * workflow's own compiled-binary smoke-test step (which runs *before* the
 * new GitHub Release exists, so `/releases/latest` still returns the
 * previous release) downgrade the freshly compiled binary back to the old
 * version. Missing a real update because of an unparsable version string
 * is an acceptable failure mode; silently downgrading is not.
 */
export function isNewerVersion(remote: string, current: string): boolean {
  const remoteFields = parseNumericFields(remote);
  const currentFields = parseNumericFields(current);
  if (remoteFields === null || currentFields === null) {
    return false;
  }

  const length = Math.max(remoteFields.length, currentFields.length);
  for (let i = 0; i < length; i += 1) {
    const remoteField = remoteFields[i] ?? 0;
    const currentField = currentFields[i] ?? 0;
    if (remoteField > currentField) {
      return true;
    }
    if (remoteField < currentField) {
      return false;
    }
  }
  return false;
}

function parseNumericFields(version: string): number[] | null {
  const segments = version.split('.');
  const fields: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) {
      return null;
    }
    fields.push(Number.parseInt(segment, 10));
  }
  return fields;
}

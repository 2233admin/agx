/**
 * Pure platform/arch -> release asset name mapping. Matches the exact
 * four asset names the release workflow publishes (`.github/workflows/
 * release-configs.yml`'s `targets` map) -- no other combination is ever
 * published, so anything not in this table returns `null` ("platform not
 * supported" in the I/O matrix) rather than guessing a name that would
 * 404.
 */
export function resolveAssetName(platform: string, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') {
    return 'configs-windows-x64.exe';
  }
  if (platform === 'linux' && arch === 'x64') {
    return 'configs-linux-x64';
  }
  if (platform === 'darwin' && arch === 'x64') {
    return 'configs-darwin-x64';
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return 'configs-darwin-arm64';
  }
  return null;
}

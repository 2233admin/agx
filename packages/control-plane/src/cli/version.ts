/**
 * Version string for the `configs` CLI. Committed source always reads
 * `'dev'` -- the release workflow (`.github/workflows/release-configs.yml`)
 * overwrites this file at build time, right before `bun build --compile`,
 * to inject the version derived from the triggering `configs-v*` git tag.
 * That overwrite happens only inside the CI runner's checkout and is never
 * committed back to git.
 */
export const CONFIGS_VERSION = 'dev';

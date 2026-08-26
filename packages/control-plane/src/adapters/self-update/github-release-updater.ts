import { createHash } from 'node:crypto';
import { rename } from 'node:fs/promises';

import type { SelfUpdatePort } from '../../application/ports';
import { resolveAssetName } from './asset-target';
import { parseSha256Sums } from './checksum';
import { isNewerVersion } from './version-compare';
import { writeToSameDirTempFile } from '../system/atomic-write';

/**
 * The one and only endpoint this adapter ever reads -- fixed, read-only
 * GET, not derived from any user-controlled or runtime value (AD-15 /
 * Boundaries & Constraints). No auth header, no token, no telemetry.
 */
const RELEASES_LATEST_URL = 'https://api.github.com/repos/Eridanus117/agent-system/releases/latest';

/** Story 2.1's tag convention (`.github/workflows/release-configs.yml`). */
const TAG_PREFIX = 'configs-v';

/** Story 2.1's checksum manifest asset name. */
const SHA256SUMS_ASSET_NAME = 'SHA256SUMS.txt';

/** Identifies requests as coming from this CLI -- required by GitHub's
 * unauthenticated REST API, carries no user-identifying information. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'configs-cli-self-update',
  Accept: 'application/vnd.github+json',
};

interface GithubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

interface GithubReleaseResponse {
  readonly tag_name: string;
  readonly assets: readonly GithubReleaseAsset[];
}

function isGithubReleaseAsset(value: unknown): value is GithubReleaseAsset {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.browser_download_url === 'string';
}

function isGithubReleaseResponse(value: unknown): value is GithubReleaseResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.tag_name === 'string' && Array.isArray(record.assets) && record.assets.every(isGithubReleaseAsset);
}

function parseVersionFromTag(tag: string): string {
  return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
}

function findAsset(assets: readonly GithubReleaseAsset[], name: string): GithubReleaseAsset | null {
  return assets.find((asset) => asset.name === name) ?? null;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Runs `run` under a boundary timeout. Unlike a bare `fetch(url, {
 * signal: AbortSignal.timeout(ms) })`, the timer is only cleared once
 * `run` itself settles -- so callers that read the response body inside
 * `run` (`.json()`/`.text()`/`.arrayBuffer()`) get that read covered by
 * the same timeout, not just the initial `fetch()` promise (which only
 * resolves once headers arrive). See Spec Change Log: a response whose
 * headers land fine but whose body stalls must still be aborted.
 */
async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort replacement of the running binary at `execPath`. Writes the
 * full new content to a sibling temp file first -- the step most likely
 * to fail (disk full, permissions) -- and only performs the two
 * near-instantaneous, destructive `rename` calls (old -> `.bak`, temp ->
 * `execPath`) once that write has fully succeeded. If the temp write
 * throws, `execPath` is never touched. See Spec Change Log / Design
 * Notes for why this ordering replaced the previous "rename first, write
 * second" approach.
 */
async function replaceBinary(execPath: string, currentVersion: string, bytes: Uint8Array): Promise<void> {
  const tempPath = await writeToSameDirTempFile(execPath, bytes, { mode: 0o755, tempSuffix: '.download' });
  const backupPath = `${execPath}.${currentVersion}.bak`;
  await rename(execPath, backupPath);
  await rename(tempPath, execPath);
}

export interface GithubReleaseUpdaterDeps {
  /** Defaults to the global `fetch`; overridable only for tests -- the
   * endpoint itself (`RELEASES_LATEST_URL`) is never configurable, so this
   * injection point cannot be used to redirect production traffic. */
  readonly fetchFn?: typeof fetch;
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly metadataTimeoutMs?: number;
  readonly assetTimeoutMs?: number;
}

/**
 * `SelfUpdatePort` implementation for the compiled release binary. Every
 * public entry point (`checkAndApply`) is wrapped in one top-level
 * try/catch: any failure at any step -- network, parsing, checksum
 * mismatch, unsupported platform, filesystem -- silently leaves the
 * current binary untouched and resolves to `null`. Only the one branch
 * where `replaceBinary` has actually succeeded resolves to the new
 * version string instead. Never throws, never writes to stdout/stderr
 * itself (the return value is data, not a display decision -- printing it
 * is the caller's job), never blocks longer than the configured boundary
 * timeouts.
 */
export class GithubReleaseUpdater implements SelfUpdatePort {
  private readonly fetchFn: typeof fetch;
  private readonly execPath: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly metadataTimeoutMs: number;
  private readonly assetTimeoutMs: number;

  constructor(deps: GithubReleaseUpdaterDeps = {}) {
    this.fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.execPath = deps.execPath ?? process.execPath;
    this.platform = deps.platform ?? process.platform;
    this.arch = deps.arch ?? process.arch;
    this.metadataTimeoutMs = deps.metadataTimeoutMs ?? 5_000;
    this.assetTimeoutMs = deps.assetTimeoutMs ?? 30_000;
  }

  async checkAndApply(currentVersion: string): Promise<string | null> {
    try {
      // Defensive early-out even though the only production caller
      // (`cli/index.ts`) already gates this -- `checkAndApply` itself
      // must never make a network request for a source/test run.
      if (currentVersion === 'dev') {
        return null;
      }

      const release = await this.fetchReleaseMetadata();
      if (release === null) {
        // 404 (no releases yet), non-2xx, or an unrecognized response
        // shape -- all treated identically as "no update available".
        return null;
      }

      const remoteVersion = parseVersionFromTag(release.tag_name);
      if (!isNewerVersion(remoteVersion, currentVersion)) {
        // Covers "already latest", "latest is older" (e.g. the release
        // workflow's own smoke-test step, which runs before the new
        // Release exists) and any unparsable version -- fail closed.
        return null;
      }

      const assetName = resolveAssetName(this.platform, this.arch);
      if (assetName === null) {
        return null;
      }

      const asset = findAsset(release.assets, assetName);
      const sumsAsset = findAsset(release.assets, SHA256SUMS_ASSET_NAME);
      if (asset === null || sumsAsset === null) {
        return null;
      }

      const sumsText = await this.downloadText(sumsAsset.browser_download_url);
      const expectedHash = parseSha256Sums(sumsText).get(assetName);
      if (expectedHash === undefined) {
        return null;
      }

      const bytes = await this.downloadBytes(asset.browser_download_url);
      if (sha256Hex(bytes) !== expectedHash) {
        return null;
      }

      await replaceBinary(this.execPath, currentVersion, bytes);
      return remoteVersion;
    } catch {
      // Fail closed and silent -- see Boundaries & Constraints. The
      // current binary keeps running as-is for the rest of this process.
      return null;
    }
  }

  private async fetchReleaseMetadata(): Promise<GithubReleaseResponse | null> {
    return withTimeout(this.metadataTimeoutMs, async (signal) => {
      const response = await this.fetchFn(RELEASES_LATEST_URL, { signal, headers: REQUEST_HEADERS });
      if (!response.ok) {
        return null;
      }
      const data: unknown = await response.json();
      return isGithubReleaseResponse(data) ? data : null;
    });
  }

  private async downloadText(url: string): Promise<string> {
    return withTimeout(this.assetTimeoutMs, async (signal) => {
      const response = await this.fetchFn(url, { signal, headers: REQUEST_HEADERS });
      if (!response.ok) {
        throw new Error(`unexpected status ${response.status} downloading ${url}`);
      }
      return response.text();
    });
  }

  private async downloadBytes(url: string): Promise<Uint8Array> {
    return withTimeout(this.assetTimeoutMs, async (signal) => {
      const response = await this.fetchFn(url, { signal, headers: REQUEST_HEADERS });
      if (!response.ok) {
        throw new Error(`unexpected status ${response.status} downloading ${url}`);
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    });
  }
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAssetName } from '../../src/adapters/self-update/asset-target';
import { parseSha256Sums } from '../../src/adapters/self-update/checksum';
import { isNewerVersion } from '../../src/adapters/self-update/version-compare';
import { GithubReleaseUpdater } from '../../src/adapters/self-update/github-release-updater';

// ---------------------------------------------------------------------------
// Pure function units -- kept as their own `describe` blocks (Spec Change
// Log's KEEP: "resolveAssetName/parseSha256Sums 纯函数设计与其独立单测"),
// even though they live in this single new test file per the Code Map.
// ---------------------------------------------------------------------------

describe('resolveAssetName', () => {
  test('maps the four published platform/arch combinations to Story 2.1 asset names', () => {
    expect(resolveAssetName('win32', 'x64')).toBe('configs-windows-x64.exe');
    expect(resolveAssetName('linux', 'x64')).toBe('configs-linux-x64');
    expect(resolveAssetName('darwin', 'x64')).toBe('configs-darwin-x64');
    expect(resolveAssetName('darwin', 'arm64')).toBe('configs-darwin-arm64');
  });

  test('returns null for any combination not published', () => {
    expect(resolveAssetName('linux', 'arm64')).toBeNull();
    expect(resolveAssetName('win32', 'arm64')).toBeNull();
    expect(resolveAssetName('aix', 'mips')).toBeNull();
  });
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_UPPER = 'ABCD'.repeat(16); // 64 chars, mixed-case hex

describe('parseSha256Sums', () => {
  test('parses standard sha256sum text-mode output (hash, space, space, filename)', () => {
    const text = `${HASH_A}  configs-linux-x64\n${HASH_B}  SHA256SUMS.txt\n`;
    const parsed = parseSha256Sums(text);
    expect(parsed.get('configs-linux-x64')).toBe(HASH_A);
    expect(parsed.get('SHA256SUMS.txt')).toBe(HASH_B);
  });

  test('parses binary-mode output (hash, space, asterisk, filename)', () => {
    const text = `${HASH_C} *configs-darwin-arm64\n`;
    expect(parseSha256Sums(text).get('configs-darwin-arm64')).toBe(HASH_C);
  });

  test('lowercases hashes and skips malformed/blank lines', () => {
    const text = `${HASH_UPPER}  upper-case-hash\n\nnot-a-valid-line\n`;
    const parsed = parseSha256Sums(text);
    expect(parsed.get('upper-case-hash')).toBe(HASH_UPPER.toLowerCase());
    expect(parsed.size).toBe(1);
  });
});

describe('isNewerVersion', () => {
  test('compares numeric fields, not lexicographic strings', () => {
    expect(isNewerVersion('1.10.0', '1.2.0')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.10.0')).toBe(false);
  });

  test('equal versions are not "newer"', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  test('a lower or equal remote version is never newer (fail-closed for the release-workflow smoke-test scenario)', () => {
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });

  test('any non-numeric field on either side returns false rather than guessing', () => {
    expect(isNewerVersion('1.2.0-rc1', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.2.0', 'dev')).toBe(false);
    expect(isNewerVersion('', '1.0.0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GithubReleaseUpdater -- I/O & Edge-Case Matrix (all seven rows) plus the
// two additional system-level scenarios from Tasks & Acceptance.
// ---------------------------------------------------------------------------

interface FakeResponseInit {
  readonly ok: boolean;
  readonly status: number;
  readonly jsonValue?: unknown;
  readonly textValue?: string;
  readonly bytesValue?: Uint8Array;
  /** If set, `.json()/.text()/.arrayBuffer()` wait this long and reject on
   * abort instead of resolving immediately -- used to simulate a response
   * whose headers arrived but whose body stalls. */
  readonly bodyDelayMs?: number;
}

function fakeResponse(init: FakeResponseInit, signal: AbortSignal | undefined): unknown {
  const readBody = <T>(value: T): Promise<T> => {
    if (init.bodyDelayMs === undefined) {
      return Promise.resolve(value);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), init.bodyDelayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    });
  };

  return {
    ok: init.ok,
    status: init.status,
    json: () => readBody(init.jsonValue),
    text: () => readBody(init.textValue ?? ''),
    arrayBuffer: () => readBody((init.bytesValue ?? new Uint8Array()).buffer),
  };
}

/** A `fetch`-shaped router keyed by exact URL (or a substring match for the
 * fixed `/releases/latest` endpoint, whose exact literal isn't exported). */
function buildFetch(
  routes: Record<string, FakeResponseInit | ((signal: AbortSignal | undefined) => FakeResponseInit) | 'hang'>,
  calls: string[],
): typeof fetch {
  const fn = async (input: string | URL, requestInit?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const key = url.includes('/releases/latest') ? 'latest' : url;
    const route = routes[key];
    if (route === undefined) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    const signal = requestInit?.signal as AbortSignal | undefined;
    if (route === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
      });
    }
    const resolved = typeof route === 'function' ? route(signal) : route;
    return fakeResponse(resolved, signal) as Response;
  };
  return fn as unknown as typeof fetch;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let tmpDir: string;
let execPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'configs-self-update-'));
  execPath = path.join(tmpDir, 'configs-exe');
  writeFileSync(execPath, 'old-binary-content', 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GithubReleaseUpdater.checkAndApply', () => {
  test('source run (currentVersion === "dev"): makes no network request at all', async () => {
    const calls: string[] = [];
    const fetchFn = buildFetch({}, calls);
    const updater = new GithubReleaseUpdater({ fetchFn, execPath });

    const result = await updater.checkAndApply('dev');

    expect(result).toBeNull();
    expect(calls).toEqual([]);
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
  });

  test('already latest version: no download, no replacement, command continues', async () => {
    const calls: string[] = [];
    const fetchFn = buildFetch(
      { latest: { ok: true, status: 200, jsonValue: { tag_name: 'configs-v1.0.0', assets: [] } } },
      calls,
    );
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'linux', arch: 'x64' });

    const result = await updater.checkAndApply('1.0.0');

    expect(result).toBeNull();
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
    expect(existsSync(`${execPath}.1.0.0.bak`)).toBe(false);
  });

  test('no release exists yet (404 from /releases/latest): treated as no update available', async () => {
    const calls: string[] = [];
    const fetchFn = buildFetch({ latest: { ok: false, status: 404 } }, calls);
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'linux', arch: 'x64' });

    const result = await updater.checkAndApply('1.0.0');

    expect(result).toBeNull();
    expect(calls.length).toBe(1);
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
  });

  test('new version, supported platform, checksum verifies: renames old binary to .bak and writes the new one in place', async () => {
    const newBytes = new TextEncoder().encode('new-binary-content');
    const hash = sha256Hex(newBytes);
    const calls: string[] = [];
    const fetchFn = buildFetch(
      {
        latest: {
          ok: true,
          status: 200,
          jsonValue: {
            tag_name: 'configs-v1.1.0',
            assets: [
              { name: 'configs-linux-x64', browser_download_url: 'https://assets.invalid/configs-linux-x64' },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://assets.invalid/SHA256SUMS.txt' },
            ],
          },
        },
        'https://assets.invalid/SHA256SUMS.txt': { ok: true, status: 200, textValue: `${hash}  configs-linux-x64\n` },
        'https://assets.invalid/configs-linux-x64': { ok: true, status: 200, bytesValue: newBytes },
      },
      calls,
    );
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'linux', arch: 'x64' });

    const result = await updater.checkAndApply('1.0.0');

    expect(result).toBe('1.1.0');
    expect(readFileSync(execPath, 'utf8')).toBe('new-binary-content');
    const backupPath = `${execPath}.1.0.0.bak`;
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf8')).toBe('old-binary-content');
  });

  test('checksum mismatch: does not replace the local binary, original file untouched', async () => {
    const newBytes = new TextEncoder().encode('new-binary-content');
    const wrongHash = '0'.repeat(64);
    const calls: string[] = [];
    const fetchFn = buildFetch(
      {
        latest: {
          ok: true,
          status: 200,
          jsonValue: {
            tag_name: 'configs-v1.1.0',
            assets: [
              { name: 'configs-linux-x64', browser_download_url: 'https://assets.invalid/configs-linux-x64' },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://assets.invalid/SHA256SUMS.txt' },
            ],
          },
        },
        'https://assets.invalid/SHA256SUMS.txt': { ok: true, status: 200, textValue: `${wrongHash}  configs-linux-x64\n` },
        'https://assets.invalid/configs-linux-x64': { ok: true, status: 200, bytesValue: newBytes },
      },
      calls,
    );
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'linux', arch: 'x64' });

    const result = await updater.checkAndApply('1.0.0');

    expect(result).toBeNull();
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
    expect(existsSync(`${execPath}.1.0.0.bak`)).toBe(false);
  });

  test('metadata request never resolves (network hang): silently gives up within the boundary timeout, no throw', async () => {
    const calls: string[] = [];
    const fetchFn = buildFetch({ latest: 'hang' }, calls);
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'linux', arch: 'x64', metadataTimeoutMs: 30 });

    const start = Date.now();
    const result = await updater.checkAndApply('1.0.0');
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2_000);
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
  });

  test('headers arrive but the response body stalls: the timeout still covers reading the body, not just fetch() resolving', async () => {
    const calls: string[] = [];
    const fetchFn = buildFetch(
      { latest: { ok: true, status: 200, jsonValue: { tag_name: 'configs-v1.1.0', assets: [] }, bodyDelayMs: 5_000 } },
      calls,
    );
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'linux', arch: 'x64', metadataTimeoutMs: 30 });

    const start = Date.now();
    const result = await updater.checkAndApply('1.0.0');
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2_000);
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
  });

  test('unsupported platform/arch: does not download or replace anything', async () => {
    const calls: string[] = [];
    const fetchFn = buildFetch(
      { latest: { ok: true, status: 200, jsonValue: { tag_name: 'configs-v1.1.0', assets: [] } } },
      calls,
    );
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'aix', arch: 'mips' });

    const result = await updater.checkAndApply('1.0.0');

    expect(result).toBeNull();
    expect(calls.length).toBe(1); // only the metadata request; never reaches asset resolution
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
  });

  test('latest release version is lower than the current version (e.g. the release workflow smoke-testing a not-yet-published tag): does not download or replace', async () => {
    const calls: string[] = [];
    const fetchFn = buildFetch(
      {
        latest: {
          ok: true,
          status: 200,
          jsonValue: {
            tag_name: 'configs-v0.9.0',
            assets: [{ name: 'configs-linux-x64', browser_download_url: 'https://assets.invalid/configs-linux-x64' }],
          },
        },
      },
      calls,
    );
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'linux', arch: 'x64' });

    const result = await updater.checkAndApply('1.0.0');

    expect(result).toBeNull();
    expect(calls.length).toBe(1); // only the metadata request; never downloads the older asset
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
  });

  test('writing the new binary fails (e.g. disk full): original execPath content and there is no half-renamed intermediate state', async () => {
    // Force the temp-file write to fail by pre-occupying its path with a
    // directory -- `writeFile` on a directory path throws before any
    // rename ever runs.
    mkdirSync(`${execPath}.download`);

    const newBytes = new TextEncoder().encode('new-binary-content');
    const hash = sha256Hex(newBytes);
    const calls: string[] = [];
    const fetchFn = buildFetch(
      {
        latest: {
          ok: true,
          status: 200,
          jsonValue: {
            tag_name: 'configs-v1.1.0',
            assets: [
              { name: 'configs-linux-x64', browser_download_url: 'https://assets.invalid/configs-linux-x64' },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://assets.invalid/SHA256SUMS.txt' },
            ],
          },
        },
        'https://assets.invalid/SHA256SUMS.txt': { ok: true, status: 200, textValue: `${hash}  configs-linux-x64\n` },
        'https://assets.invalid/configs-linux-x64': { ok: true, status: 200, bytesValue: newBytes },
      },
      calls,
    );
    const updater = new GithubReleaseUpdater({ fetchFn, execPath, platform: 'linux', arch: 'x64' });

    const result = await updater.checkAndApply('1.0.0');

    expect(result).toBeNull();
    // Original binary untouched, no backup was ever created (rename never ran).
    expect(readFileSync(execPath, 'utf8')).toBe('old-binary-content');
    expect(existsSync(`${execPath}.1.0.0.bak`)).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';

import { resolveClientSupport } from '../../src/domain/client';

describe('resolveClientSupport', () => {
  test('omp is supported', () => {
    const result = resolveClientSupport('omp');
    expect(result.supported).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // `[Story 4.6]` Story 4.1~4.5b delivered a real, fail-closed Claude Code
  // adapter (probe -> plan -> launch/resume -> interpret + AD-21 content
  // materialization); this flips the product-level gate symmetrically with
  // `'omp'` above, so `configs use/switch --client claude-code` can reach
  // it. The real fail-closed evidence gathering still happens per launch
  // attempt, at `compileClaudeAssemblyManifest` time -- this function
  // itself performs no detection.
  test('claude-code is supported (Story 4.6: real adapter exists)', () => {
    const result = resolveClientSupport('claude-code');
    expect(result.supported).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('codex-cli is not supported and names the future adapter boundary', () => {
    const result = resolveClientSupport('codex-cli');
    expect(result.supported).toBe(false);
    expect(result.reason).toContain('codex-cli');
    expect(result.reason).toMatch(/future adapter boundary/);
  });
});

import { describe, expect, test } from 'bun:test';

import { compileClaudeAssemblyManifest } from '../../src/adapters/clients/claude/assembly-manifest';
import type { ClaudeAssemblyManifest } from '../../src/adapters/clients/claude/assembly-manifest';
import type { ClaudeCapabilityProbeResult } from '../../src/application/ports';
import type { CapabilityReference, StableConfigRevision } from '../../src/domain/config';
import { known } from '../../src/domain/facts';

function ref(
  kind: CapabilityReference['kind'],
  name: string,
  source: CapabilityReference['sourceCategory'] = known('project-capability'),
): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: source,
    summary: known(`${kind} reference: ${name}`),
    sourceRef: known(`ref/${name}`),
    contentFingerprint: known(`fingerprint/${name}`),
  };
}

function revision(overrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }): StableConfigRevision {
  return {
    configName: overrides.configName,
    revisionId: overrides.revisionId,
    defaultMarker: overrides.defaultMarker ?? known(false),
    scopeBoundary: overrides.scopeBoundary ?? known('a scope boundary'),
    availability: overrides.availability ?? known('resolved'),
    instructions: overrides.instructions ?? [],
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    hooks: overrides.hooks ?? [],
    plugins: overrides.plugins ?? [],
    triggerCategory: overrides.triggerCategory ?? 'new-scenario',
    evidenceRef: overrides.evidenceRef ?? 'test-evidence',
    supersedesRevisionId: overrides.supersedesRevisionId ?? null,
  };
}

function probeResult(
  overrides: Partial<ClaudeCapabilityProbeResult> & { capabilityId: string },
): ClaudeCapabilityProbeResult {
  return {
    capabilityId: overrides.capabilityId,
    subject: overrides.subject ?? `subject for ${overrides.capabilityId}`,
    required: overrides.required ?? true,
    status: overrides.status ?? 'supported',
    validationMethod: overrides.validationMethod ?? 'mechanical',
    evidenceRef: overrides.evidenceRef ?? `evidence for ${overrides.capabilityId}`,
    observedAt: overrides.observedAt ?? '2026-01-01T00:00:00Z',
  };
}

/** All four Story 4.1 capabilities, all fully `supported`/honestly `unknown`, matching a healthy real environment. */
function allSupportedProbeResults(overrides: Partial<Record<string, Partial<ClaudeCapabilityProbeResult>>> = {}): ClaudeCapabilityProbeResult[] {
  const base: ClaudeCapabilityProbeResult[] = [
    probeResult({ capabilityId: 'claude.permission-mode-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.mcp-project-scope-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.setting-sources-control', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.hook-deny-return-value', required: false, status: 'unknown' }),
    // `[Story 4.5b]` AD-21's content-materialization delivery gates.
    probeResult({ capabilityId: 'claude.plugin-dir-delivery', required: true, status: 'supported' }),
    probeResult({ capabilityId: 'claude.append-system-prompt-delivery', required: true, status: 'supported' }),
  ];
  return base.map((result) => ({ ...result, ...(overrides[result.capabilityId] ?? {}) }));
}

function expectCompiled(result: ReturnType<typeof compileClaudeAssemblyManifest>): ClaudeAssemblyManifest {
  if (result.kind !== 'compiled') {
    throw new Error(`expected a compiled manifest, got blocked: ${JSON.stringify(result)}`);
  }
  return result.manifest;
}

describe('compileClaudeAssemblyManifest', () => {
  test('零引用（无 skills/mcp/hooks）: only permission-mode is relevant; supported -> manifestStatus ready', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-empty' });
    const result = compileClaudeAssemblyManifest(rev, allSupportedProbeResults());
    const manifest = expectCompiled(result);

    expect(manifest.capabilityPolicy.map((n) => n.capabilityId)).toEqual(['claude.permission-mode-control']);
    expect(manifest.manifestStatus).toBe('ready');
    expect(manifest.degradedCapabilities).toEqual([]);
    expect(manifest.client).toBe('claude-code');
    expect(manifest.revisionId).toBe('rev-empty');
    expect(manifest.configName).toBe('general');
  });

  test('引用 MCP 且 mcp-project-scope-control unsupported/unknown（required: true）-> 整体 blocked，missingRequiredCapabilities 含该项，不产出 manifestHash', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-mcp', mcp: [ref('mcp', 'some-mcp')] });
    const results = allSupportedProbeResults({
      'claude.mcp-project-scope-control': { status: 'unsupported', required: true },
    });
    const result = compileClaudeAssemblyManifest(rev, results);

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.missingRequiredCapabilities).toEqual(['claude.mcp-project-scope-control']);
      expect(result.revisionId).toBe('rev-mcp');
      expect(result.configName).toBe('general');
      expect('manifestHash' in result).toBe(false);
    }
  });

  test('引用 skills 且 setting-sources-control degraded -> manifestStatus degraded，degradedCapabilities 含该项，仍产出 manifest', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-skills', skills: [ref('skill', 'some-skill')] });
    const results = allSupportedProbeResults({
      'claude.setting-sources-control': { status: 'degraded', required: true },
    });
    const result = compileClaudeAssemblyManifest(rev, results);
    const manifest = expectCompiled(result);

    expect(manifest.manifestStatus).toBe('degraded');
    expect(manifest.degradedCapabilities).toEqual(['claude.setting-sources-control']);
    expect(manifest.manifestHash.length).toBeGreaterThan(0);
  });

  test('引用 hooks（hook-deny-return-value 恒为 unknown, required: false）-> manifestStatus degraded（可选项缺失，不 blocked）', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-hooks', hooks: [ref('hook', 'some-hook')] });
    const result = compileClaudeAssemblyManifest(rev, allSupportedProbeResults());
    const manifest = expectCompiled(result);

    expect(manifest.capabilityPolicy.map((n) => n.capabilityId).sort()).toEqual([
      'claude.hook-deny-return-value',
      'claude.permission-mode-control',
    ]);
    expect(manifest.manifestStatus).toBe('degraded');
    expect(manifest.degradedCapabilities).toEqual(['claude.hook-deny-return-value']);
  });

  test('相同 revision + 两次探测结果（capabilityId/required/status 相同，evidenceRef/observedAt 不同）-> 两次 manifestHash 完全相同', () => {
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-stable',
      skills: [ref('skill', 'some-skill')],
      hooks: [ref('hook', 'some-hook')],
    });
    const firstProbe = allSupportedProbeResults();
    const secondProbe = firstProbe.map((result) => ({
      ...result,
      evidenceRef: `${result.evidenceRef} (second run)`,
      observedAt: '2026-02-02T00:00:00Z',
    }));

    const firstManifest = expectCompiled(compileClaudeAssemblyManifest(rev, firstProbe));
    const secondManifest = expectCompiled(compileClaudeAssemblyManifest(rev, secondProbe));

    expect(secondManifest.manifestHash).toBe(firstManifest.manifestHash);
    // Sanity: this isn't trivially true because the inputs were identical --
    // evidenceRef genuinely differs between the two probe runs.
    expect(firstManifest.capabilityPolicy.find((n) => n.capabilityId === 'claude.setting-sources-control')?.evidenceRef).not.toBe(
      secondManifest.capabilityPolicy.find((n) => n.capabilityId === 'claude.setting-sources-control')?.evidenceRef,
    );
  });

  test('probe 结果不含某个相关 capabilityId（防御性构造）-> 视为 required:true,status:unknown，触发 blocked，不静默判为 supported', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-missing-probe', skills: [ref('skill', 'some-skill')] });
    const resultsMissingSettingSources = allSupportedProbeResults().filter(
      (result) => result.capabilityId !== 'claude.setting-sources-control',
    );

    const result = compileClaudeAssemblyManifest(rev, resultsMissingSettingSources);

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.missingRequiredCapabilities).toEqual(['claude.setting-sources-control']);
    }
  });

  test('manifestHash 变化时 manifestStatus 不同步影响：一个 blocked 结果永不携带 manifestHash/capabilityPolicy/degradedCapabilities 字段', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-blocked-shape', mcp: [ref('mcp', 'm')] });
    const results = allSupportedProbeResults({ 'claude.mcp-project-scope-control': { status: 'unknown', required: true } });
    const result = compileClaudeAssemblyManifest(rev, results);

    expect(result.kind).toBe('blocked');
    const serialized = Object.keys(result);
    expect(serialized).not.toContain('manifestHash');
    expect(serialized).not.toContain('capabilityPolicy');
    expect(serialized).not.toContain('degradedCapabilities');
  });

  test('manifest 不复制引用内容原文：instructions/skills/mcp 与 revision 上的对象引用值相等（同一份数组/对象），不新增内容字段', () => {
    const skillRefs = [ref('skill', 'skill-a')];
    const mcpRefs = [ref('mcp', 'mcp-a')];
    const instructionRefs = [ref('instruction', 'prompt-a')];
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-refs',
      instructions: instructionRefs,
      skills: skillRefs,
      mcp: mcpRefs,
    });
    const manifest = expectCompiled(compileClaudeAssemblyManifest(rev, allSupportedProbeResults()));

    expect(manifest.instructions).toBe(instructionRefs);
    expect(manifest.skills).toBe(skillRefs);
    expect(manifest.mcp).toBe(mcpRefs);
    // No content field beyond what CapabilityReference already declares.
    for (const group of [manifest.instructions, manifest.skills, manifest.mcp]) {
      for (const capability of group) {
        expect(Object.keys(capability).sort()).toEqual(
          ['contentFingerprint', 'kind', 'name', 'sourceCategory', 'sourceRef', 'summary'].sort(),
        );
      }
    }
    // Never any hooks/plugins typed-reference field on the manifest itself.
    expect('hooks' in manifest).toBe(false);
    expect('plugins' in manifest).toBe(false);
  });

  test('never produces a candidate/score/recommendation field (SPEC.md CAP-1)', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-cap1', skills: [ref('skill', 's')] });
    const result = compileClaudeAssemblyManifest(rev, allSupportedProbeResults());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/candidate|score|recommend/i);
  });

  test('manifestHash is content-sensitive: changing a relevant capability\'s status (same revisionId) changes the hash', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-hash-content', skills: [ref('skill', 'some-skill')] });
    const supportedManifest = expectCompiled(compileClaudeAssemblyManifest(rev, allSupportedProbeResults()));
    const degradedManifest = expectCompiled(
      compileClaudeAssemblyManifest(
        rev,
        allSupportedProbeResults({ 'claude.setting-sources-control': { status: 'degraded', required: true } }),
      ),
    );

    expect(degradedManifest.manifestHash).not.toBe(supportedManifest.manifestHash);
  });

  test('manifestHash is content-sensitive: changing the referenced skill/mcp set (same revisionId) changes the hash', () => {
    const revA = revision({ configName: 'general', revisionId: 'rev-hash-refs', skills: [ref('skill', 'skill-a')] });
    const revB = revision({ configName: 'general', revisionId: 'rev-hash-refs', skills: [ref('skill', 'skill-b')] });

    const manifestA = expectCompiled(compileClaudeAssemblyManifest(revA, allSupportedProbeResults()));
    const manifestB = expectCompiled(compileClaudeAssemblyManifest(revB, allSupportedProbeResults()));

    expect(manifestB.manifestHash).not.toBe(manifestA.manifestHash);
  });

  test('manifestHash is order-independent over the reference arrays: the same skill set in a different array order hashes the same', () => {
    const forward = revision({
      configName: 'general',
      revisionId: 'rev-hash-order',
      skills: [ref('skill', 'skill-a'), ref('skill', 'skill-b')],
    });
    const reversed = revision({
      configName: 'general',
      revisionId: 'rev-hash-order',
      skills: [ref('skill', 'skill-b'), ref('skill', 'skill-a')],
    });

    const forwardManifest = expectCompiled(compileClaudeAssemblyManifest(forward, allSupportedProbeResults()));
    const reversedManifest = expectCompiled(compileClaudeAssemblyManifest(reversed, allSupportedProbeResults()));

    expect(reversedManifest.manifestHash).toBe(forwardManifest.manifestHash);
  });

  test('[Story 4.5b] claude.plugin-dir-delivery is relevant exactly when skills are referenced', () => {
    const withSkills = revision({ configName: 'general', revisionId: 'rev-plugin-dir', skills: [ref('skill', 's')] });
    const manifest = expectCompiled(compileClaudeAssemblyManifest(withSkills, allSupportedProbeResults()));
    expect(manifest.capabilityPolicy.map((n) => n.capabilityId)).toContain('claude.plugin-dir-delivery');

    const withoutSkills = revision({ configName: 'general', revisionId: 'rev-no-plugin-dir' });
    const manifestNoSkills = expectCompiled(compileClaudeAssemblyManifest(withoutSkills, allSupportedProbeResults()));
    expect(manifestNoSkills.capabilityPolicy.map((n) => n.capabilityId)).not.toContain('claude.plugin-dir-delivery');
  });

  test('[Story 4.5b] claude.append-system-prompt-delivery is relevant exactly when instructions are referenced', () => {
    const withInstructions = revision({
      configName: 'general',
      revisionId: 'rev-append-prompt',
      instructions: [ref('instruction', 'prompt.md')],
    });
    const manifest = expectCompiled(compileClaudeAssemblyManifest(withInstructions, allSupportedProbeResults()));
    expect(manifest.capabilityPolicy.map((n) => n.capabilityId)).toContain('claude.append-system-prompt-delivery');

    const withoutInstructions = revision({ configName: 'general', revisionId: 'rev-no-append-prompt' });
    const manifestNoInstructions = expectCompiled(compileClaudeAssemblyManifest(withoutInstructions, allSupportedProbeResults()));
    expect(manifestNoInstructions.capabilityPolicy.map((n) => n.capabilityId)).not.toContain('claude.append-system-prompt-delivery');
  });

  test('[Story 4.5b] claude.plugin-dir-delivery unsupported (required) blocks the manifest when skills are referenced', () => {
    const rev = revision({ configName: 'general', revisionId: 'rev-plugin-dir-blocked', skills: [ref('skill', 's')] });
    const results = allSupportedProbeResults({ 'claude.plugin-dir-delivery': { status: 'unsupported', required: true } });
    const result = compileClaudeAssemblyManifest(rev, results);

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.missingRequiredCapabilities).toEqual(['claude.plugin-dir-delivery']);
    }
  });

  test('multiple simultaneously-blocked required capabilities are all listed in missingRequiredCapabilities', () => {
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-multi-blocked',
      mcp: [ref('mcp', 'some-mcp')],
      skills: [ref('skill', 'some-skill')],
    });
    const results = allSupportedProbeResults({
      'claude.mcp-project-scope-control': { status: 'unsupported', required: true },
      'claude.setting-sources-control': { status: 'unknown', required: true },
    });

    const result = compileClaudeAssemblyManifest(rev, results);

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect([...result.missingRequiredCapabilities].sort()).toEqual(
        ['claude.mcp-project-scope-control', 'claude.setting-sources-control'].sort(),
      );
    }
  });
});

// `[Story 4.7]` The `describe('compileClaudeAssemblyManifest against the real
// .cap/ (general, agent-assembler)', ...)` block that lived here (Story 4.5)
// compiled `compileClaudeAssemblyManifest` against `loadCapConfigRevisions`
// output read from the real repo `.cap/` directory. `.cap/` was retired by
// Story 4.7 once its real smoke-parity precondition was met (see
// spec-4-7-退役-cap-本体.md's Auto Run Result for the captured evidence and
// the archived version of this block's final passing run); the manifest
// compilation behavior it exercised (ready status, stable hash across two
// probe runs, expected capabilityPolicy ids for a skills+instructions-only,
// mcp/hooks-empty revision) remains covered above by this file's synthetic-
// revision tests, which do not depend on `.cap/` existing on disk.

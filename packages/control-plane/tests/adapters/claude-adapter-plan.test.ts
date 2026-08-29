import { describe, expect, test } from 'bun:test';

import { argvContributingCapabilityIds, buildClaudeAdapterPlanArgv, compileClaudeAdapterPlan, determineClaudeLaunchTarget } from '../../src/adapters/clients/claude/adapter-plan';
import { compileClaudeAssemblyManifest } from '../../src/adapters/clients/claude/assembly-manifest';
import type { ClaudeAssemblyManifest, ClaudeAssemblyManifestCapabilityNote } from '../../src/adapters/clients/claude/assembly-manifest';
import type { ClaudeCapabilityProbeResult } from '../../src/application/ports';
import type { CapabilityReference, StableConfigRevision } from '../../src/domain/config';
import { known } from '../../src/domain/facts';

function ref(kind: CapabilityReference['kind'], name: string): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: known('project-capability'),
    summary: known(`${kind}: ${name}`),
    sourceRef: known(`ref/${name}`),
    contentFingerprint: known(`fingerprint/${name}`),
  };
}

function revision(overrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }): StableConfigRevision {
  return {
    configName: overrides.configName,
    revisionId: overrides.revisionId,
    defaultMarker: known(false),
    scopeBoundary: known('a scope boundary'),
    availability: known('resolved'),
    instructions: overrides.instructions ?? [],
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    hooks: overrides.hooks ?? [],
    plugins: overrides.plugins ?? [],
    triggerCategory: 'new-scenario',
    evidenceRef: 'test-evidence',
    supersedesRevisionId: null,
  };
}

function probeResult(overrides: Partial<ClaudeCapabilityProbeResult> & { capabilityId: string }): ClaudeCapabilityProbeResult {
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

function compiledManifest(revisionOverrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }, probeOverrides: Partial<Record<string, Partial<ClaudeCapabilityProbeResult>>> = {}): ClaudeAssemblyManifest {
  const result = compileClaudeAssemblyManifest(revision(revisionOverrides), allSupportedProbeResults(probeOverrides));
  if (result.kind !== 'compiled') {
    throw new Error(`expected a compiled manifest, got blocked: ${JSON.stringify(result)}`);
  }
  return result.manifest;
}

function note(capabilityId: string, status: ClaudeAssemblyManifestCapabilityNote['status'], required = true): ClaudeAssemblyManifestCapabilityNote {
  return probeResult({ capabilityId, status, required });
}

describe('determineClaudeLaunchTarget', () => {
  test('returns "fresh" only when evidence proves this is the fresh spawn itself', () => {
    expect(determineClaudeLaunchTarget({ ownsFreshSpawn: true })).toBe('fresh');
  });

  test('fail closed to "already-running" when fresh-spawn evidence is absent', () => {
    expect(determineClaudeLaunchTarget({ ownsFreshSpawn: false })).toBe('already-running');
  });
});

describe('buildClaudeAdapterPlanArgv', () => {
  test('permission-mode baseline always contributes its flag when supported', () => {
    const argv = buildClaudeAdapterPlanArgv([note('claude.permission-mode-control', 'supported')]);
    expect(argv).toEqual(['--permission-mode', 'manual']);
  });

  test('mcp-project-scope-control contributes --strict-mcp-config when supported or degraded', () => {
    expect(buildClaudeAdapterPlanArgv([note('claude.mcp-project-scope-control', 'supported')])).toEqual(['--strict-mcp-config']);
    expect(buildClaudeAdapterPlanArgv([note('claude.mcp-project-scope-control', 'degraded')])).toEqual(['--strict-mcp-config']);
  });

  test('setting-sources-control contributes --setting-sources project when supported or degraded', () => {
    expect(buildClaudeAdapterPlanArgv([note('claude.setting-sources-control', 'supported')])).toEqual(['--setting-sources', 'project']);
    expect(buildClaudeAdapterPlanArgv([note('claude.setting-sources-control', 'degraded')])).toEqual(['--setting-sources', 'project']);
  });

  test('hook-deny-return-value never contributes argv, even when (defensively) marked supported', () => {
    expect(buildClaudeAdapterPlanArgv([note('claude.hook-deny-return-value', 'supported', false)])).toEqual([]);
    expect(buildClaudeAdapterPlanArgv([note('claude.hook-deny-return-value', 'unknown', false)])).toEqual([]);
  });

  test('unsupported/unknown capabilities never fabricate an enforced flag', () => {
    expect(buildClaudeAdapterPlanArgv([note('claude.mcp-project-scope-control', 'unsupported')])).toEqual([]);
    expect(buildClaudeAdapterPlanArgv([note('claude.setting-sources-control', 'unknown')])).toEqual([]);
  });

  test('multiple relevant capabilities concatenate in the given order', () => {
    const argv = buildClaudeAdapterPlanArgv([
      note('claude.permission-mode-control', 'supported'),
      note('claude.mcp-project-scope-control', 'supported'),
      note('claude.setting-sources-control', 'degraded'),
    ]);
    expect(argv).toEqual(['--permission-mode', 'manual', '--strict-mcp-config', '--setting-sources', 'project']);
  });
});

describe('argvContributingCapabilityIds', () => {
  test('excludes hook-deny-return-value even when relevant and (defensively) supported', () => {
    const ids = argvContributingCapabilityIds([
      note('claude.permission-mode-control', 'supported'),
      note('claude.hook-deny-return-value', 'supported', false),
    ]);
    expect(ids).toEqual(['claude.permission-mode-control']);
  });

  test('excludes unsupported/unknown capabilities even if they normally map to a flag', () => {
    const ids = argvContributingCapabilityIds([
      note('claude.mcp-project-scope-control', 'unsupported'),
      note('claude.setting-sources-control', 'unknown'),
    ]);
    expect(ids).toEqual([]);
  });

  test('includes both supported and degraded contributing capabilities', () => {
    const ids = argvContributingCapabilityIds([
      note('claude.permission-mode-control', 'supported'),
      note('claude.mcp-project-scope-control', 'degraded'),
    ]);
    expect(ids).toEqual(['claude.permission-mode-control', 'claude.mcp-project-scope-control']);
  });
});

describe('compileClaudeAdapterPlan', () => {
  test('fresh launchTarget, argv/envKeys/generatedFiles/expectedObservation shape for a zero-reference manifest', () => {
    const manifest = compiledManifest({ configName: 'general', revisionId: 'rev-empty' });
    const plan = compileClaudeAdapterPlan(manifest);

    expect(plan.client).toBe('claude-code');
    expect(plan.launchTarget).toBe('fresh');
    expect(plan.manifestHash).toBe(manifest.manifestHash);
    expect(plan.argv).toEqual(['--permission-mode', 'manual']);
    expect(plan.envKeys).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(plan.generatedFiles).toEqual([{ purpose: 'launch-context-diagnostic' }]);
    expect(plan.expectedObservation).toEqual({ launchTarget: 'fresh', maxObservationStage: 'observed', successExitCode: 0 });
    expect(plan.planHash.length).toBeGreaterThan(0);
  });

  test('[Story 4.5b][patch] generatedFiles declares claude-plugin-dir/append-system-prompt/mcp-config exactly when the corresponding manifest reference group is non-empty', () => {
    const manifest = compiledManifest({
      configName: 'general',
      revisionId: 'rev-generated-files-all',
      instructions: [ref('instruction', 'i')],
      skills: [ref('skill', 's')],
      mcp: [ref('mcp', 'm')],
    });
    const plan = compileClaudeAdapterPlan(manifest);

    expect(plan.generatedFiles).toEqual([
      { purpose: 'launch-context-diagnostic' },
      { purpose: 'claude-plugin-dir' },
      { purpose: 'append-system-prompt' },
      { purpose: 'mcp-config' },
    ]);
  });

  test('[Story 4.5b][patch] generatedFiles omits claude-plugin-dir/append-system-prompt/mcp-config when their reference group is empty', () => {
    const manifest = compiledManifest({ configName: 'general', revisionId: 'rev-generated-files-skills-only', skills: [ref('skill', 's')] });
    const plan = compileClaudeAdapterPlan(manifest);

    expect(plan.generatedFiles).toEqual([{ purpose: 'launch-context-diagnostic' }, { purpose: 'claude-plugin-dir' }]);
  });

  test('argv reflects mcp + skills references when both are present and supported', () => {
    const manifest = compiledManifest({ configName: 'general', revisionId: 'rev-mcp-skills', mcp: [ref('mcp', 'm')], skills: [ref('skill', 's')] });
    const plan = compileClaudeAdapterPlan(manifest);
    expect(plan.argv).toEqual(['--permission-mode', 'manual', '--strict-mcp-config', '--setting-sources', 'project']);
  });

  test('never carries a secret/content-bearing field -- only argv/envKeys(names)/generatedFiles(metadata)/hashes', () => {
    const manifest = compiledManifest({ configName: 'general', revisionId: 'rev-shape', skills: [ref('skill', 's')] });
    const plan = compileClaudeAdapterPlan(manifest);
    expect(Object.keys(plan).sort()).toEqual(
      ['argv', 'client', 'envKeys', 'expectedObservation', 'generatedFiles', 'launchTarget', 'manifestHash', 'planHash'].sort(),
    );
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toMatch(/candidate|score|recommend/i);
  });

  test('planHash is deterministic: recompiling the same manifest twice yields the same hash', () => {
    const manifest = compiledManifest({ configName: 'general', revisionId: 'rev-stable', skills: [ref('skill', 's')] });
    const planA = compileClaudeAdapterPlan(manifest);
    const planB = compileClaudeAdapterPlan(manifest);
    expect(planB.planHash).toBe(planA.planHash);
  });

  test('planHash changes when the underlying manifestHash changes (different referenced skill)', () => {
    const manifestA = compiledManifest({ configName: 'general', revisionId: 'rev-hash-a', skills: [ref('skill', 'skill-a')] });
    const manifestB = compiledManifest({ configName: 'general', revisionId: 'rev-hash-a', skills: [ref('skill', 'skill-b')] });
    const planA = compileClaudeAdapterPlan(manifestA);
    const planB = compileClaudeAdapterPlan(manifestB);
    expect(planA.manifestHash).not.toBe(manifestB.manifestHash);
    expect(planA.planHash).not.toBe(planB.planHash);
  });

  test('a degraded (but compiled) manifest still produces a usable plan -- no partial/blocked shape leaks through', () => {
    const manifest = compiledManifest(
      { configName: 'general', revisionId: 'rev-degraded', skills: [ref('skill', 's')] },
      { 'claude.setting-sources-control': { status: 'degraded', required: true } },
    );
    expect(manifest.manifestStatus).toBe('degraded');
    const plan = compileClaudeAdapterPlan(manifest);
    expect(plan.argv).toContain('--setting-sources');
    expect(plan.planHash.length).toBeGreaterThan(0);
  });
});

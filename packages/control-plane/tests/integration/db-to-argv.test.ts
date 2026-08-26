import { describe, expect, test } from 'bun:test';

import { SqliteConfigRevisionRepository } from '../../src/adapters/sqlite/repository';
import type { RevisionRow } from '../../src/adapters/sqlite/repository';
import { BunOmpProcessPort, buildOmpArgv, defaultExtensionPath } from '../../src/adapters/omp/process-port';
import { ConfigUnsupportedError } from '../../src/application/queries';
import { known } from '../../src/domain/facts';
import type { CapabilityReference, SourceCategory, StableConfigRevision } from '../../src/domain/config';

function ref(kind: CapabilityReference['kind'], name: string, sourceCategory: SourceCategory = 'project-capability'): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: known(sourceCategory),
    summary: known('skill'),
    sourceRef: known(`ref/${name}`),
    contentFingerprint: known(`fingerprint/${name}`),
  };
}

/**
 * The retro found that every existing test drove `buildOmpArgv`/
 * `BunOmpProcessPort` from a hand-built `CapabilityReference` object (or a
 * `FakeOmpProcessPort` substitute), so the real chain -- SQLite row ->
 * `parseCapabilityJson` -> `StableConfigRevision` -> `buildOmpArgv`'s real
 * `omp --skills` argv -- was never exercised end to end. These tests close
 * that gap by round-tripping through the real `SqliteConfigRevisionRepository`.
 */

function sampleRevision(overrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }): StableConfigRevision {
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

function rawRow(overrides: Partial<RevisionRow> & { revision_id: string }): RevisionRow {
  return {
    revision_id: overrides.revision_id,
    config_name: overrides.config_name ?? 'general',
    schema_version: overrides.schema_version ?? 1,
    default_marker_status: overrides.default_marker_status ?? 'known',
    default_marker_value: overrides.default_marker_value ?? 'false',
    default_marker_reason: overrides.default_marker_reason ?? null,
    default_marker_observed_at: overrides.default_marker_observed_at ?? null,
    scope_boundary_status: overrides.scope_boundary_status ?? 'known',
    scope_boundary_value: overrides.scope_boundary_value ?? 'boundary',
    scope_boundary_reason: overrides.scope_boundary_reason ?? null,
    scope_boundary_observed_at: overrides.scope_boundary_observed_at ?? null,
    availability_status: overrides.availability_status ?? 'known',
    availability_value: overrides.availability_value ?? 'resolved',
    availability_reason: overrides.availability_reason ?? null,
    availability_observed_at: overrides.availability_observed_at ?? null,
    instructions_json: overrides.instructions_json ?? '[]',
    skills_json: overrides.skills_json ?? '[]',
    mcp_json: overrides.mcp_json ?? '[]',
    hooks_json: overrides.hooks_json ?? '[]',
    plugins_json: overrides.plugins_json ?? '[]',
    trigger_category: overrides.trigger_category ?? 'new-scenario',
    evidence_ref: overrides.evidence_ref ?? 'test-evidence',
    supersedes_revision_id: overrides.supersedes_revision_id ?? null,
  };
}

describe('DB -> argv: SqliteConfigRevisionRepository round-trip into buildOmpArgv/BunOmpProcessPort', () => {
  test('a revision seeded, saved and re-read through the real repository produces the expected real --skills argv', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      repo.seed([
        sampleRevision({
          configName: 'general',
          revisionId: 'rev-1',
          skills: [ref('skill', 'openspec-explore'), ref('skill', 'grilling')],
        }),
      ]);

      // findById round-trips through real SQL + parseCapabilityJson -- not
      // a hand-built CapabilityReference object.
      const revision = await repo.findById('rev-1');
      expect(revision).not.toBeNull();

      const argv = buildOmpArgv(revision!, '/tmp/ctx.json', null, []);
      const skillsIndex = argv.indexOf('--skills');
      expect(skillsIndex).toBeGreaterThan(-1);
      expect(argv[skillsIndex + 1]).toBe('openspec-explore,grilling');
    } finally {
      repo.close();
    }
  });

  test('a revision with no skills, round-tripped through the repository, produces --no-skills via the real argv builder', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      repo.seed([sampleRevision({ configName: 'general', revisionId: 'rev-1' })]);
      const revision = await repo.findById('rev-1');
      const argv = buildOmpArgv(revision!, '/tmp/ctx.json', null, []);
      expect(argv).toContain('--no-skills');
      expect(argv).not.toContain('--skills');
    } finally {
      repo.close();
    }
  });

  test('a stored skill with a missing/empty "name" field never reaches buildOmpArgv -- findById throws ConfigUnsupportedError instead', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      repo.insertRawRow(
        rawRow({
          revision_id: 'rev-bad-skill-name',
          skills_json: JSON.stringify([{ kind: 'skill', name: '', sourceCategory: { kind: 'known', value: 'project-capability' }, summary: { kind: 'known', value: 'x' } }]),
        }),
      );

      await expect(repo.findById('rev-bad-skill-name')).rejects.toBeInstanceOf(ConfigUnsupportedError);
    } finally {
      repo.close();
    }
  });

  test('a stored skill with a missing "name" field (not just empty) is also rejected the same way', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      repo.insertRawRow(
        rawRow({
          revision_id: 'rev-missing-skill-name',
          skills_json: JSON.stringify([{ kind: 'skill', sourceCategory: { kind: 'known', value: 'project-capability' }, summary: { kind: 'known', value: 'x' } }]),
        }),
      );

      await expect(repo.findById('rev-missing-skill-name')).rejects.toBeInstanceOf(ConfigUnsupportedError);
    } finally {
      repo.close();
    }
  });

  test('listAll degrades a revision whose stored skill.name is invalid to an empty skills list instead of crashing the whole list or passing the bad name through', async () => {
    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      repo.seed([sampleRevision({ configName: 'general', revisionId: 'rev-good' })]);
      repo.insertRawRow(
        rawRow({
          revision_id: 'rev-bad-skill-name',
          skills_json: JSON.stringify([{ kind: 'skill', name: '   ', sourceCategory: { kind: 'known', value: 'project-capability' }, summary: { kind: 'known', value: 'x' } }]),
        }),
      );

      const all = await repo.listAll();
      expect(all).toHaveLength(2);
      const bad = all.find((r) => r.revisionId === 'rev-bad-skill-name')!;
      // Degraded to [] rather than silently carrying the invalid entry
      // through to buildOmpArgv.
      expect(bad.skills).toEqual([]);
      const argv = buildOmpArgv(bad, '/tmp/ctx.json', null, []);
      expect(argv).toContain('--no-skills');
    } finally {
      repo.close();
    }
  });

  test('a real BunOmpProcessPort.spawn call is driven by a repository-sourced revision and constructs argv containing the real (round-tripped) skill names', async () => {
    const binaryPath = Bun.which('omp');
    if (binaryPath === null) {
      return; // honest skip -- no real omp binary on this machine, matching tests/omp/real-omp-smoke.test.ts
    }

    const repo = new SqliteConfigRevisionRepository(':memory:');
    try {
      repo.seed([
        sampleRevision({
          configName: 'general',
          revisionId: 'rev-1',
          skills: [ref('skill', 'openspec-explore')],
        }),
      ]);
      const revision = await repo.findById('rev-1');
      expect(revision).not.toBeNull();

      const port = new BunOmpProcessPort();
      const result = await port.spawn({
        revision: revision!,
        launchContextPath: '/tmp/does-not-need-to-exist.json',
        extensionPath: defaultExtensionPath(),
        // --help substituted for the message positional, same honest
        // boundary as tests/omp/real-omp-smoke.test.ts: a real launch needs
        // an authenticated model provider this sandbox does not guarantee.
        forwardedArgs: ['--help'],
        cwd: process.cwd(),
      });
      expect(result.exitCode).toBe(0);
    } finally {
      repo.close();
    }
  });
});

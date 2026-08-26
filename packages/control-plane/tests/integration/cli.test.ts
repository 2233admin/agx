import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../src/cli/index';
import { SqliteConfigRevisionRepository } from '../../src/adapters/sqlite/repository';
import type { RevisionRow } from '../../src/adapters/sqlite/repository';
import { known, unknown } from '../../src/domain/facts';
import type { CapabilityReference, SourceCategory, StableConfigRevision } from '../../src/domain/config';

function ref(kind: CapabilityReference['kind'], name: string, sourceCategory: SourceCategory = 'project-capability'): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: known(sourceCategory),
    summary: known(`${kind} reference: ${name}`),
    sourceRef: known(`ref/${name}`),
    contentFingerprint: known(`fingerprint/${name}`),
  };
}

function sampleRevision(overrides: Partial<StableConfigRevision> & { configName: string; revisionId: string }): StableConfigRevision {
  return {
    configName: overrides.configName,
    revisionId: overrides.revisionId,
    defaultMarker: overrides.defaultMarker ?? known(false),
    scopeBoundary: overrides.scopeBoundary ?? known('a scope boundary'),
    availability: overrides.availability ?? known('resolved'),
    instructions: overrides.instructions ?? [ref('instruction', '.cap/prompts/x.md', 'project-prompt')],
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    hooks: overrides.hooks ?? [],
    plugins: overrides.plugins ?? [],
    triggerCategory: overrides.triggerCategory ?? 'new-scenario',
    evidenceRef: overrides.evidenceRef ?? 'test-evidence',
    supersedesRevisionId: overrides.supersedesRevisionId ?? null,
  };
}

function revisionRowFixture(overrides: Partial<RevisionRow> & Pick<RevisionRow, 'revision_id' | 'config_name'>): RevisionRow {
  return {
    schema_version: 1,
    default_marker_status: 'known',
    default_marker_value: 'false',
    default_marker_reason: null,
    default_marker_observed_at: null,
    scope_boundary_status: 'known',
    scope_boundary_value: 'boundary',
    scope_boundary_reason: null,
    scope_boundary_observed_at: null,
    availability_status: 'known',
    availability_value: 'resolved',
    availability_reason: null,
    availability_observed_at: null,
    instructions_json: '[]',
    skills_json: '[]',
    mcp_json: '[]',
    hooks_json: '[]',
    plugins_json: '[]',
    trigger_category: 'new-scenario',
    evidence_ref: 'test-evidence',
    supersedes_revision_id: null,
    ...overrides,
  };
}

let tmpDir: string;
let dbPath: string;
let logs: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-cli-'));
  dbPath = path.join(tmpDir, 'db.sqlite3');
  process.env.CONTROL_PLANE_DB_PATH = dbPath;
  // `[DELTA]` default output language is now `zh`; these assertions were
  // written against the (unchanged) English strings, so pin the language
  // explicitly rather than rewrite every assertion.
  process.env.CONFIGS_LANG = 'en';

  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  delete process.env.CONTROL_PLANE_DB_PATH;
  delete process.env.CONFIGS_LANG;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seed(revisions: readonly StableConfigRevision[]): void {
  const repo = new SqliteConfigRevisionRepository(dbPath);
  try {
    repo.seed(revisions);
  } finally {
    repo.close();
  }
}

describe('configs list', () => {
  test('列表-有配置: shows name, revision id, default/generic marker, boundary, status; nothing hidden or ranked', async () => {
    seed([
      sampleRevision({ configName: 'general', revisionId: 'rev-general', defaultMarker: known(true), scopeBoundary: known('general boundary') }),
      sampleRevision({ configName: 'reviewer', revisionId: 'rev-reviewer', defaultMarker: known(false), availability: unknown('not-resolved', 'now') }),
    ]);

    const code = await main(['list']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('general');
    expect(output).toContain('rev-general');
    expect(output).toContain('[default]');
    expect(output).toContain('reviewer');
    expect(output).toContain('rev-reviewer');
    expect(output).toContain('[generic]');
    // Unavailable/unknown items are shown, not hidden.
    expect(output).toContain('Unknown');
    expect(output).not.toMatch(/score|rank|recommend/i);
  });

  test('列表-空: honest empty state, not a product failure', async () => {
    const code = await main(['list']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('No saved configuration revisions found');
  });

  test('defaultMarker Unknown renders as Unknown, never guessed as default or generic', async () => {
    seed([
      sampleRevision({
        configName: 'mystery',
        revisionId: 'rev-mystery',
        defaultMarker: unknown('cap-manifest-defaults-field-is-not-a-per-profile-role-marker', 'now'),
      }),
    ]);
    const code = await main(['list']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('mystery');
    expect(output).toContain('Unknown (cap-manifest-defaults-field-is-not-a-per-profile-role-marker');
    expect(output).not.toContain('[default]');
    expect(output).not.toContain('[generic]');
  });
});

describe('configs show', () => {
  test('详情-正常: groups Instructions/Skills/MCP with typed references, source category, summary, boundary and status', async () => {
    seed([
      sampleRevision({
        configName: 'general',
        revisionId: 'rev-general',
        skills: [ref('skill', 'openspec-explore')],
      }),
    ]);

    const code = await main(['show', 'rev-general']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Configuration: general');
    expect(output).toContain('Instructions:');
    expect(output).toContain('Skills:');
    expect(output).toContain('openspec-explore');
    expect(output).toContain('MCP:');
  });

  test('详情-私域引用: only the typed reference and controlled status are shown, never private content/credentials/prompt/transcript/tool payload', async () => {
    seed([
      sampleRevision({
        configName: 'agent-assembler',
        revisionId: 'rev-private',
        skills: [ref('skill', 'private-domain-skill', 'project-skill-import')],
      }),
    ]);

    const code = await main(['show', 'rev-private']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('private-domain-skill');
    // Only the typed reference/summary is emitted -- never raw secrets.
    expect(output.toLowerCase()).not.toMatch(/api[_-]?key|token|secret|password|transcript/);
  });

  test('详情-未找到: unknown id shows the identifier, a typed reason and a recovery entry; exits non-zero; does not silently fall back to a default', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-general' })]);

    const code = await main(['show', 'does-not-exist']);
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('does-not-exist');
    expect(output).toContain('not found');
    expect(output).toContain('Recovery');
    expect(output).not.toContain('rev-general');
  });

  test('详情-解析失败/版本不支持: typed failure reason, identifier and recovery entry; exits non-zero; other configs unaffected', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-good' })]);
    const repo = new SqliteConfigRevisionRepository(dbPath);
    try {
      repo.insertRawRow(
        revisionRowFixture({
          revision_id: 'rev-bad',
          config_name: 'general',
          schema_version: 99,
        }),
      );
    } finally {
      repo.close();
    }

    const badCode = await main(['show', 'rev-bad']);
    expect(badCode).toBe(1);
    expect(logs.join('\n')).toContain('rev-bad');
    expect(logs.join('\n')).toContain('unsupported');

    logs = [];
    const goodCode = await main(['show', 'rev-good']);
    expect(goodCode).toBe(0);
    expect(logs.join('\n')).toContain('Configuration: general');
  });

  test('装配来源-正常: detail includes trigger category, evidence ref, and each capability reference\'s source ref/content fingerprint', async () => {
    seed([
      sampleRevision({
        configName: 'general',
        revisionId: 'rev-general',
        triggerCategory: 'known-insufficiency',
        evidenceRef: 'issue/123',
        skills: [ref('skill', 'openspec-explore')],
      }),
    ]);

    const code = await main(['show', 'rev-general']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('known-insufficiency');
    expect(output).toContain('issue/123');
    expect(output).toContain('ref/openspec-explore');
    expect(output).toContain('fingerprint/openspec-explore');
  });

  test('替代链-无前驱无后继: an unsuperseded, never-superseded revision explicitly prints "(none)" for both directions', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-solo', supersedesRevisionId: null })]);

    const code = await main(['show', 'rev-solo']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Superseded from: (none)');
    expect(output).toContain('Superseded by: (none)');
  });

  test('替代链-有前驱有后继: A <- B <- C; viewing C lists predecessors oldest -> newest, viewing A lists successors nearest -> farthest', async () => {
    seed([
      sampleRevision({ configName: 'general', revisionId: 'rev-a', supersedesRevisionId: null }),
      sampleRevision({ configName: 'general', revisionId: 'rev-b', supersedesRevisionId: 'rev-a' }),
      sampleRevision({ configName: 'general', revisionId: 'rev-c', supersedesRevisionId: 'rev-b' }),
    ]);

    const codeC = await main(['show', 'rev-c']);
    expect(codeC).toBe(0);
    expect(logs.join('\n')).toContain('Superseded from: rev-a, rev-b');

    logs = [];
    const codeA = await main(['show', 'rev-a']);
    expect(codeA).toBe(0);
    expect(logs.join('\n')).toContain('Superseded by: rev-b, rev-c');
  });

  test('替代链-悬空引用: a supersedesRevisionId pointing outside the stored set is marked unresolvable, not thrown; command still exits 0', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-dangling', supersedesRevisionId: 'rev-ghost' })]);

    const code = await main(['show', 'rev-dangling']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('unresolvable (rev-ghost)');
    expect(output).toContain('Configuration: general');
  });
});

describe('configs compare', () => {
  test('比较-多个: mechanical side-by-side composition/source/boundary/missing/differences/Unknown; no score/rank/recommendation', async () => {
    seed([
      sampleRevision({ configName: 'general', revisionId: 'rev-a', scopeBoundary: known('boundary A'), skills: [ref('skill', 'shared')] }),
      sampleRevision({ configName: 'reviewer', revisionId: 'rev-b', scopeBoundary: known('boundary B'), skills: [] }),
    ]);

    const code = await main(['compare', 'rev-a', 'rev-b']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('rev-a');
    expect(output).toContain('rev-b');
    expect(output).toContain('missing in: rev-b');
    expect(output).not.toMatch(/score|rank|recommend/i);
  });

  test('比较-含无效id: valid ids compare normally; invalid ids are listed separately with a typed reason; output is not aborted', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-a' })]);

    const code = await main(['compare', 'rev-a', 'does-not-exist']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('rev-a');
    expect(output).toContain('does-not-exist');
    expect(output).toContain('not found');
    expect(output).toContain('Unresolved ids');
  });

  test('比较-全部id无效: every provided id fails to resolve; no silent success, exits non-zero, typed reasons for every id, no comparison table fabricated', async () => {
    const code = await main(['compare', 'does-not-exist-1', 'does-not-exist-2']);
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(output).toContain('No valid configuration revisions were resolved to compare.');
    expect(output).toContain('Unresolved ids:');
    expect(output).toContain('does-not-exist-1');
    expect(output).toContain('does-not-exist-2');
    expect(output).toContain('not found');
    expect(output).not.toMatch(/score|rank|recommend/i);
  });

  test('单独查看一个配置不要求先构建比较集合: `show` on one id gives a full view without needing a second id', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-a' })]);
    const code = await main(['show', 'rev-a']);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Configuration: general');
  });

  test('repeated ids are de-duplicated rather than shown twice', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-a' })]);
    const code = await main(['compare', 'rev-a', 'rev-a']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Comparing 1 revision(s): rev-a');
    expect(output).not.toContain('Comparing 2 revision(s)');
  });

  test('a valid id and an unsupported (schema_version) id compare gracefully: the good revision compares normally, the bad id is reported as unresolved, nothing throws', async () => {
    seed([sampleRevision({ configName: 'general', revisionId: 'rev-good' })]);
    const repo = new SqliteConfigRevisionRepository(dbPath);
    try {
      repo.insertRawRow(
        revisionRowFixture({
          revision_id: 'rev-bad',
          config_name: 'general',
          schema_version: 99,
        }),
      );
    } finally {
      repo.close();
    }

    const code = await main(['compare', 'rev-good', 'rev-bad']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Comparing 1 revision(s): rev-good');
    expect(output).toContain('Unresolved ids');
    expect(output).toContain('rev-bad');
    expect(output).toContain('unsupported');
  });

  test('differing source categories for the same capability name are shown per-revision, not just as an aggregate "different" status', async () => {
    seed([
      sampleRevision({
        configName: 'general',
        revisionId: 'rev-a',
        skills: [ref('skill', 'shared')],
      }),
      sampleRevision({
        configName: 'reviewer',
        revisionId: 'rev-b',
        skills: [ref('skill', 'shared', 'project-skill-import')],
      }),
    ]);

    const code = await main(['compare', 'rev-a', 'rev-b']);
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('[source: different]');
    expect(output).toContain('rev-a: project-capability');
    expect(output).toContain('rev-b: project-skill-import');
  });
});

describe('configs usage errors', () => {
  // `[DELTA]` IA first layer (spec-cli-ux-delta.md): `configs` with no
  // subcommand at all is no longer a usage error -- it now prints usage
  // text and exits 0, same as a successful help request. The
  // interactive-TTY case (which instead enters the TUI) is handled at the
  // `import.meta.main` dispatch layer, not inside `main()` itself.
  test('no command: prints usage text and exits 0, never touches the database file', async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('usage: configs');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('unknown command: exits 2, prints usage, never touches the database file', async () => {
    const code = await main(['frobnicate']);
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('unknown command: frobnicate');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('`show` with no id: exits 2, prints usage, never touches the database file', async () => {
    const code = await main(['show']);
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('missing <id>');
    expect(existsSync(dbPath)).toBe(false);
  });

  test('`compare` with fewer than 2 ids: exits 2, prints usage, never touches the database file', async () => {
    const code = await main(['compare', 'rev-a']);
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('requires at least 2 ids');
    expect(existsSync(dbPath)).toBe(false);
  });
});

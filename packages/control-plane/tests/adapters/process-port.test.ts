import { describe, expect, test } from 'bun:test';

import { DENYLISTED_FORWARDED_ARG_TOKENS, buildOmpArgv, findDenylistedForwardedArg } from '../../src/adapters/omp/process-port';
import { known } from '../../src/domain/facts';
import type { CapabilityReference, StableConfigRevision } from '../../src/domain/config';

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

describe('buildOmpArgv', () => {
  test('does not select a named profile, so configs reuses direct omp auth/session/settings/cache state', () => {
    const argv = buildOmpArgv(revision({ configName: 'general', revisionId: 'rev-1' }), '/tmp/ctx.json', null, []);
    expect(argv.some((arg) => arg === '--profile' || arg.startsWith('--profile='))).toBe(false);
  });
  test('config names are not part of argv, so spaces, slashes, and non-ASCII remain valid', () => {
    const argv = buildOmpArgv(revision({ configName: '审阅/版本 with spaces', revisionId: 'rev-奇异' }), '/tmp/ctx.json', null, []);
    expect(argv).not.toContain('--profile');
    expect(argv).toEqual(['--no-skills']);
  });

  test('when extensionPath is provided, emits no profile and loads only the thin extension', () => {
    const argv = buildOmpArgv(revision({ configName: 'general', revisionId: 'rev-1' }), '/tmp/ctx.json', '/path/to/ext.ts', []);
    expect(argv.some((arg) => arg === '--profile' || arg.startsWith('--profile='))).toBe(false);
    expect(argv).toContain('--no-extensions');
    const eIndex = argv.indexOf('-e');
    expect(eIndex).toBeGreaterThan(-1);
    expect(argv[eIndex + 1]).toBe('/path/to/ext.ts');
  });

  test('when extensionPath is null, no extension-related flags are emitted', () => {
    const argv = buildOmpArgv(revision({ configName: 'general', revisionId: 'rev-1' }), '/tmp/ctx.json', null, []);
    expect(argv).not.toContain('--no-extensions');
    expect(argv).not.toContain('-e');
  });

  test('non-empty skills produce a comma-separated --skills list of names only', () => {
    const rev = revision({
      configName: 'general',
      revisionId: 'rev-1',
      skills: [ref('skill', 'openspec-explore'), ref('skill', 'grilling')],
    });
    const argv = buildOmpArgv(rev, '/tmp/ctx.json', null, []);
    const skillsIndex = argv.indexOf('--skills');
    expect(skillsIndex).toBeGreaterThan(-1);
    expect(argv[skillsIndex + 1]).toBe('openspec-explore,grilling');
    expect(argv).not.toContain('--no-skills');
  });

  test('empty skills produce --no-skills, not an empty --skills value', () => {
    const argv = buildOmpArgv(revision({ configName: 'general', revisionId: 'rev-1' }), '/tmp/ctx.json', null, []);
    expect(argv).toContain('--no-skills');
    expect(argv).not.toContain('--skills');
  });

  test('forwarded args are appended verbatim and last, as opaque values', () => {
    const argv = buildOmpArgv(revision({ configName: 'general', revisionId: 'rev-1' }), '/tmp/ctx.json', null, ['do the thing', '--not-a-real-flag']);
    expect(argv.slice(-2)).toEqual(['do the thing', '--not-a-real-flag']);
  });

  test('non-ASCII / spaced paths in extensionPath pass through untouched -- argv array, no shell escaping needed', () => {
    const weirdPath = 'C:/Users/名前 with spaces/ext ①.ts';
    const argv = buildOmpArgv(revision({ configName: 'general', revisionId: 'rev-1' }), '/tmp/ctx.json', weirdPath, []);
    expect(argv).toContain(weirdPath);
  });

  test('never emits any flag that clears/rewrites/restores the global OMP config directory', () => {
    const argv = buildOmpArgv(
      revision({ configName: 'general', revisionId: 'rev-1', skills: [ref('skill', 's')] }),
      '/tmp/ctx.json',
      '/ext.ts',
      ['--print'],
    );
    const forbidden = ['--session-dir', '-r', '--resume', '-c', '--continue', '--config'];
    for (const flag of forbidden) {
      expect(argv).not.toContain(flag);
    }
  });

  test('never embeds the launch context path in argv -- delivered via env var only', () => {
    const argv = buildOmpArgv(revision({ configName: 'general', revisionId: 'rev-1' }), '/tmp/some-launch-context.json', null, []);
    expect(argv).not.toContain('/tmp/some-launch-context.json');
  });
});

describe('findDenylistedForwardedArg', () => {
  test('returns null when no forwarded arg matches the denylist', () => {
    expect(findDenylistedForwardedArg([])).toBeNull();
    expect(findDenylistedForwardedArg(['do the task', '--not-a-real-flag', '--model=opus'])).toBeNull();
  });

  for (const token of DENYLISTED_FORWARDED_ARG_TOKENS) {
    test(`flags exact token "${token}"`, () => {
      expect(findDenylistedForwardedArg([token])).toBe(token);
      expect(findDenylistedForwardedArg(['harmless', token, 'trailing'])).toBe(token);
    });
  }

  test('flags "--flag=value" forms by matching the token before "="', () => {
    expect(findDenylistedForwardedArg(['--profile=work'])).toBe('--profile=work');
    expect(findDenylistedForwardedArg(['--resume=abc123'])).toBe('--resume=abc123');
    expect(findDenylistedForwardedArg(['--session-dir=/tmp/x'])).toBe('--session-dir=/tmp/x');
  });

  test('does not flag unrelated flags that merely contain a denylisted substring', () => {
    expect(findDenylistedForwardedArg(['--session-dirs', '--profiles', '--extensions'])).toBeNull();
  });
});

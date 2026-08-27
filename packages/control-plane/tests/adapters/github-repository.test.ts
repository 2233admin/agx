import { describe, expect, test } from 'bun:test';

import type { GithubRepositoryCommandPort, GithubRepositorySourcePort } from '../../src/application/ports';
import type { GithubRepositoryTarget } from '../../src/domain/github-repository';
import { GithubRepositoryAdapter } from '../../src/adapters/github/repository';

const INITIAL_COMMIT = 'b'.repeat(40);
const TARGET: GithubRepositoryTarget = {
  owner: 'octocat',
  name: 'agent-control',
  visibility: 'private',
  description: 'deployment control repository',
  sourcePath: 'C:/staging/agent-control',
  initialRevision: {
    commit: INITIAL_COMMIT,
    templateVersion: 'v1',
    templateDigest: 'a'.repeat(64),
    requiredPaths: ['README.md', 'control.yaml'],
  },
};

const VALID_SOURCE: GithubRepositorySourcePort = { validate: async () => ({ kind: 'valid' }) };

function makeAdapter(command: GithubRepositoryCommandPort): GithubRepositoryAdapter {
  return new GithubRepositoryAdapter(command, VALID_SOURCE);
}

type FixtureResponse = { readonly stdout: string; readonly exitCode: number | null };

class FixtureGh implements GithubRepositoryCommandPort {
  readonly calls: readonly (readonly string[])[] = [];
  private readonly responses: FixtureResponse[];

  constructor(...responses: FixtureResponse[]) {
    this.responses = [...responses];
  }

  async run(args: readonly string[]): Promise<FixtureResponse> {
    (this.calls as (readonly string[])[]).push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`missing fixture for ${args.join(' ')}`);
    return response;
  }
}

function json(value: unknown, exitCode: number | null = 0): FixtureResponse {
  return { stdout: JSON.stringify(value), exitCode };
}

function absent(): FixtureResponse {
  return json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'] }] });
}

function present(overrides: Record<string, unknown> = {}): FixtureResponse {
  return json({
    data: {
      repository: {
        nameWithOwner: 'octocat/agent-control',
        url: 'https://github.com/octocat/agent-control',
        visibility: 'PRIVATE',
        hasIssuesEnabled: true,
        defaultBranchRef: { name: 'main', target: { oid: INITIAL_COMMIT } },
        object: { oid: INITIAL_COMMIT },
        ...overrides,
      },
    },
  });
}

function tree(): FixtureResponse {
  return json({ truncated: false, tree: [{ path: 'README.md', type: 'blob' }, { path: 'control.yaml', type: 'blob' }] });
}

describe('GithubRepositoryAdapter', () => {
  test('preflight parses structured absence and never mutates', async () => {
    const gh = new FixtureGh(json({ login: 'octocat' }), absent());
    const adapter = makeAdapter(gh);

    await expect(adapter.preflight(TARGET)).resolves.toEqual({ kind: 'ready' });
    expect(gh.calls.some((args) => args[0] === 'repo' || args[0] === 'repo')).toBe(false);
    expect(gh.calls).toHaveLength(2);
  });

  test('provisions only after absence, sets requested visibility, and readbacks initial revision', async () => {
    const gh = new FixtureGh(
      json({ login: 'octocat' }),
      absent(),
      json({}),
      json({}),
      present(),
      tree(),
    );
    const adapter = makeAdapter(gh);

    const result = await adapter.provision(TARGET);

    expect(result).toEqual({
      kind: 'created',
      repository: {
        nameWithOwner: 'octocat/agent-control',
        url: 'https://github.com/octocat/agent-control',
        visibility: 'private',
        hasIssues: true,
        defaultBranch: 'main',
        headCommit: INITIAL_COMMIT,
        initialCommit: INITIAL_COMMIT,
      },
      ownership: 'created-by-configs',
      initialRevision: TARGET.initialRevision,
      binding: {
        kind: 'github-repository',
        resourceId: 'octocat/agent-control',
        ownership: 'unknown',
        remoteIdentity: 'https://github.com/octocat/agent-control',
        destructiveActions: 'denied',
      },
    });
    const createCall = gh.calls.find((args) => args[0] === 'repo' && args[1] === 'create');
    expect(createCall).toEqual([
      'repo', 'create', 'octocat/agent-control', '--private', '--description', TARGET.description,
      '--source', TARGET.sourcePath, '--remote', 'origin', '--push',
    ]);
    expect(gh.calls.find((args) => args[0] === 'repo' && args[1] === 'edit')).toEqual([
      'repo', 'edit', 'octocat/agent-control', '--enable-issues',
    ]);
  });

  test('same-name repository is a typed collision and is never adopted or mutated', async () => {
    const gh = new FixtureGh(json({ login: 'octocat' }), present());
    const adapter = makeAdapter(gh);

    await expect(adapter.provision(TARGET)).resolves.toEqual({
      kind: 'collision',
      repository: expect.objectContaining({ nameWithOwner: 'octocat/agent-control' }),
      ownership: 'pre-existing',
    });
    expect(gh.calls).toHaveLength(2);
  });

  test('malformed or mismatched readback stays inconclusive and retains the remote resource', async () => {
    const gh = new FixtureGh(
      json({ login: 'octocat' }),
      absent(),
      json({}),
      json({}),
      present({ defaultBranchRef: { name: 'main', target: { oid: 'c'.repeat(40) } }, object: null }),
      tree(),
    );
    const adapter = makeAdapter(gh);

    await expect(adapter.provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive',
      stage: 'readback',
      reason: 'initial-revision-mismatch',
      remoteRetention: 'retain',
    });
  });

  test('inconclusive preflight does not become absence and does not create', async () => {
    const gh = new FixtureGh(json({ login: 'octocat' }), json({ data: { repository: null } }));
    const adapter = makeAdapter(gh);

    await expect(adapter.provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive',
      stage: 'preflight',
      reason: 'repository-inventory-inconclusive',
      remoteRetention: 'retain',
    });
    expect(gh.calls).toHaveLength(2);
  });
  test('command timeout during preflight is inconclusive and cannot trigger create', async () => {
    const command: GithubRepositoryCommandPort = {
      async run(): Promise<{ readonly stdout: string; readonly exitCode: number | null }> {
        throw new Error('timeout');
      },
    };
    const adapter = makeAdapter(command);

    await expect(adapter.provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive',
      stage: 'preflight',
      reason: 'github-command-inconclusive',
      remoteRetention: 'retain',
    });
  });
  test('rejects an invalid source before the create command', async () => {
    const gh = new FixtureGh(json({ login: 'octocat' }), absent());
    const source: GithubRepositorySourcePort = {
      validate: async () => ({ kind: 'invalid', reason: 'source-path-is-not-a-regular-contained-directory' }),
    };
    const adapter = new GithubRepositoryAdapter(gh, source);

    await expect(adapter.provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive',
      stage: 'create',
      reason: 'source-path-invalid:source-path-is-not-a-regular-contained-directory',
      remoteRetention: 'retain',
    });
    expect(gh.calls).toHaveLength(2);
  });
  test('accepts later commits while preserving the requested initial commit readback', async () => {
    const laterCommit = 'c'.repeat(40);
    const gh = new FixtureGh(
      json({ login: 'octocat' }),
      absent(),
      json({}),
      json({}),
      present({ defaultBranchRef: { name: 'main', target: { oid: laterCommit } }, object: { oid: INITIAL_COMMIT } }),
      tree(),
    );
    const adapter = makeAdapter(gh);

    const result = await adapter.provision(TARGET);

    expect(result.kind).toBe('created');
    if (result.kind === 'created') {
      expect(result.repository.headCommit).toBe(laterCommit);
      expect(result.repository.initialCommit).toBe(INITIAL_COMMIT);
    }
  });
});

import { describe, expect, test } from 'bun:test';

import type { GithubProjectCommandPort } from '../../src/application/ports';
import type { GithubProjectTarget } from '../../src/domain/github-project';
import { GithubProjectAdapter } from '../../src/adapters/github/project';

const TARGET: GithubProjectTarget = {
  owner: 'octocat',
  title: 'Agent System Control',
  visibility: 'private',
  linkedRepository: 'octocat/agent-control',
  installationId: 'install-123',
};

interface FixtureResponse { readonly stdout: string; readonly exitCode: number | null }

class FixtureGh implements GithubProjectCommandPort {
  readonly calls: readonly (readonly string[])[] = [];
  private readonly responses: FixtureResponse[];

  constructor(...responses: FixtureResponse[]) { this.responses = [...responses]; }

  async run(args: readonly string[]): Promise<FixtureResponse> {
    (this.calls as (readonly string[])[]).push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`missing fixture for ${args.join(' ')}`);
    return response;
  }
}

function json(value: unknown, exitCode = 0): FixtureResponse {
  return { stdout: JSON.stringify(value), exitCode };
}

function raw(stdout: string, exitCode = 0): FixtureResponse {
  return { stdout, exitCode };
}

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'PVT_kwDO123', number: 7, owner: { login: 'octocat' }, public: false,
    title: TARGET.title, url: 'https://github.com/users/octocat/projects/7', ...overrides,
  };
}

function inventory(items: readonly unknown[] = []): FixtureResponse {
  return json({ projects: items, totalCount: items.length });
}

function auth(): FixtureResponse {
  return json({ hosts: { 'github.com': [{ active: true, scopes: 'repo,project' }] } });
}

function linkedRepository(overrides: Record<string, unknown> = {}): FixtureResponse {
  return json({
    hasIssuesEnabled: true,
    projectsV2: { nodes: [{ id: 'PVT_kwDO123', number: 7, title: TARGET.title, url: 'https://github.com/users/octocat/projects/7', ...overrides }] },
  });
}

describe('GithubProjectAdapter', () => {
  test('preflight accepts structured empty inventory without mutation', async () => {
    const gh = new FixtureGh(auth(), inventory());
    const adapter = new GithubProjectAdapter(gh);

    await expect(adapter.preflight(TARGET)).resolves.toEqual({ kind: 'ready' });
    expect(gh.calls.some((args) => args[1] === 'create' || args[1] === 'edit' || args[1] === 'link')).toBe(false);
  });
  test('malformed auth or inventory JSON is inconclusive and never creates', async () => {
    const gh = new FixtureGh(raw('{'));
    await expect(new GithubProjectAdapter(gh).provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive', stage: 'preflight', reason: 'github-project-scope-inconclusive', remoteRetention: 'retain',
    });

    const inventoryMalformed = new FixtureGh(auth(), raw('{'));
    await expect(new GithubProjectAdapter(inventoryMalformed).provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive', stage: 'preflight', reason: 'project-inventory-inconclusive', remoteRetention: 'retain',
    });
  });

  test('creates, configures visibility, links repository, and reads back exact identity', async () => {
    const gh = new FixtureGh(
      auth(), inventory(), json(project({ public: true })), json(project()), json({}), json(project()), linkedRepository(),
    );
    const adapter = new GithubProjectAdapter(gh);

    await expect(adapter.provision(TARGET)).resolves.toMatchObject({
      kind: 'created', ownership: 'created-by-configs', linked: true,
      identity: expect.objectContaining({ owner: 'octocat', number: 7, title: TARGET.title, visibility: 'private' }),
      binding: { ownership: 'unknown', destructiveActions: 'denied' },
    });
    expect(gh.calls.some((args) => args[0] === 'project' && args[1] === 'create')).toBe(true);
    expect(gh.calls.some((args) => args[0] === 'project' && args[1] === 'link')).toBe(true);
  });

  test('same-title inventory entry is a collision and is never adopted', async () => {
    const gh = new FixtureGh(auth(), inventory([project()]));
    const adapter = new GithubProjectAdapter(gh);

    await expect(adapter.provision(TARGET)).resolves.toMatchObject({ kind: 'collision', ownership: 'pre-existing' });
    expect(gh.calls.some((args) => args[1] === 'create')).toBe(false);
  });

  test('malformed JSON or nonzero readback remains inconclusive with remote retention', async () => {
    const malformed = new FixtureGh(auth(), inventory(), json(project()), json(project()), json(project(), 1));
    await expect(new GithubProjectAdapter(malformed).provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive', stage: 'readback', reason: 'github-command-inconclusive', remoteRetention: 'retain',
    });

    const invalid = new FixtureGh(auth(), json({ projects: [{ title: TARGET.title }], totalCount: 1 }));
    await expect(new GithubProjectAdapter(invalid).provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive', stage: 'preflight', reason: 'project-inventory-inconclusive', remoteRetention: 'retain',
    });
  });

  test('identity, visibility, issues, and link mismatches never become success', async () => {
    const identityMismatch = new FixtureGh(auth(), inventory(), json(project()), json(project({ owner: { login: 'other' } })), json(project({ owner: { login: 'other' } })));
    await expect(new GithubProjectAdapter(identityMismatch).provision(TARGET)).resolves.toMatchObject({ kind: 'inconclusive', remoteRetention: 'retain' });

    const missingLink = new FixtureGh(auth(), inventory(), json(project()), json(project()), json(project()), linkedRepository({ id: 'PVT_other' }));
    await expect(new GithubProjectAdapter(missingLink).provision(TARGET)).resolves.toMatchObject({ kind: 'inconclusive', stage: 'readback', remoteRetention: 'retain' });
  });
  test('missing repository Issues remains inconclusive even when the Project exists', async () => {
    const gh = new FixtureGh(auth(), inventory(), json(project()), json({}), json(project()), json({ hasIssuesEnabled: false, projectsV2: { nodes: [project()] } }));
    await expect(new GithubProjectAdapter(gh).provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive', stage: 'readback', reason: 'issues-disabled', remoteRetention: 'retain',
    });
  });

  test('timeout or unavailable response does not become absence', async () => {
    const gh: GithubProjectCommandPort = { async run() { throw new Error('timeout'); } };
    await expect(new GithubProjectAdapter(gh).provision(TARGET)).resolves.toEqual({
      kind: 'inconclusive', stage: 'preflight', reason: 'github-command-inconclusive', remoteRetention: 'retain',
    });
  });
});

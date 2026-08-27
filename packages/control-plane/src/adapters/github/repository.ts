import { known } from '../../domain/facts';
import type { GithubRepositoryCommandPort, GithubRepositoryPort } from '../../application/ports';
import type {
  GithubRepositoryInspection,
  GithubRepositoryPreflightResult,
  GithubRepositoryProvisionResult,
  GithubRepositoryReadbackResult,
  GithubRepositoryTarget,
} from '../../domain/github-repository';

const REPOSITORY_QUERY = 'query($owner:String!,$name:String!,$commit:String){repository(owner:$owner,name:$name){nameWithOwner url visibility hasIssuesEnabled defaultBranchRef{name target{... on Commit{oid}}} object(expression:$commit){... on Commit{oid}}}}';
const TREE_ENDPOINT = (owner: string, name: string): string => `repos/${owner}/${name}/git/trees/HEAD?recursive=1`;
const HEX_COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const HEX_DIGEST = /^[0-9a-f]{64}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface GithubGraphqlResponse {
  readonly data?: { readonly repository?: unknown };
  readonly errors?: readonly { readonly type?: unknown; readonly path?: unknown }[];
}

interface GithubTreeResponse {
  readonly truncated?: unknown;
  readonly tree?: readonly { readonly path?: unknown; readonly type?: unknown }[];
}

function parseJson(stdout: string): unknown | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function isStructuredAbsence(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const response = value as GithubGraphqlResponse;
  if (response.data?.repository !== null || response.errors === undefined || response.errors.length !== 1) return false;
  const error = response.errors[0];
  if (error === undefined) return false;
  return error.type === 'NOT_FOUND' && Array.isArray(error.path) && error.path.length === 1 && error.path[0] === 'repository';
}

function parseVisibility(value: unknown): 'private' | 'public' | null {
  if (value === 'PRIVATE' || value === 'private') return 'private';
  if (value === 'PUBLIC' || value === 'public') return 'public';
  return null;
}

function parseInspection(value: unknown): GithubRepositoryInspection | null {
  if (value === null || typeof value !== 'object') return null;
  const response = value as GithubGraphqlResponse;
  const repository = response.data?.repository;
  if (repository === null || typeof repository !== 'object') return null;
  const record = repository as Record<string, unknown>;
  const defaultBranchRef = record.defaultBranchRef;
  const target = defaultBranchRef !== null && typeof defaultBranchRef === 'object'
    ? (defaultBranchRef as Record<string, unknown>).target
    : null;
  const object = record.object;
  const headCommit = target !== null && typeof target === 'object' ? (target as Record<string, unknown>).oid : null;
  const initialCommit = object !== null && typeof object === 'object' ? (object as Record<string, unknown>).oid : null;
  const visibility = parseVisibility(record.visibility);
  if (typeof record.nameWithOwner !== 'string' || typeof record.url !== 'string' || visibility === null ||
      typeof record.hasIssuesEnabled !== 'boolean' || defaultBranchRef === null || typeof defaultBranchRef !== 'object' ||
      typeof (defaultBranchRef as Record<string, unknown>).name !== 'string' || typeof headCommit !== 'string' ||
      !HEX_COMMIT.test(headCommit) || (initialCommit !== null && (typeof initialCommit !== 'string' || !HEX_COMMIT.test(initialCommit)))) {
    return null;
  }
  return {
    nameWithOwner: record.nameWithOwner,
    url: record.url,
    visibility,
    hasIssues: record.hasIssuesEnabled,
    defaultBranch: (defaultBranchRef as Record<string, unknown>).name as string,
    headCommit,
    initialCommit: initialCommit as string | null,
  };
}

function validRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\') || value.includes('\u0000')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function validateTarget(target: GithubRepositoryTarget): void {
  if (!IDENTIFIER.test(target.owner) || !IDENTIFIER.test(target.name) ||
      (target.visibility !== 'private' && target.visibility !== 'public') || target.description.includes('\u0000') ||
      target.sourcePath.trim() === '' || !HEX_COMMIT.test(target.initialRevision.commit) ||
      target.initialRevision.templateVersion.trim() === '' || !HEX_DIGEST.test(target.initialRevision.templateDigest) ||
      target.initialRevision.requiredPaths.length === 0 || target.initialRevision.requiredPaths.some((path) => !validRelativePath(path))) {
    throw new Error('invalid GitHub repository target');
  }
}

function argsForRepositoryQuery(target: GithubRepositoryTarget, includeCommit: boolean): readonly string[] {
  const args = ['api', 'graphql', '-f', `query=${REPOSITORY_QUERY}`, '-F', `owner=${target.owner}`, '-F', `name=${target.name}`];
  if (includeCommit) args.push('-F', `commit=${target.initialRevision.commit}`);
  return args;
}

function repositoryMatchesTarget(target: GithubRepositoryTarget, repository: GithubRepositoryInspection): boolean {
  return repository.nameWithOwner.toLowerCase() === `${target.owner}/${target.name}`.toLowerCase() &&
    repository.visibility === target.visibility && repository.defaultBranch === 'main' &&
    repository.headCommit.toLowerCase() === target.initialRevision.commit.toLowerCase() &&
    repository.initialCommit?.toLowerCase() === target.initialRevision.commit.toLowerCase();
}

function inconclusive(stage: 'preflight' | 'create' | 'visibility' | 'readback', reason: string): GithubRepositoryProvisionResult {
  return { kind: 'inconclusive', stage, reason, remoteRetention: 'retain' };
}

export class GithubRepositoryAdapter implements GithubRepositoryPort {
  constructor(private readonly command: GithubRepositoryCommandPort) {}

  async preflight(target: GithubRepositoryTarget): Promise<GithubRepositoryPreflightResult> {
    validateTarget(target);
    try {
      const auth = await this.command.run(['api', 'user']);
      const authPayload = parseJson(auth.stdout);
      if (auth.exitCode !== 0 || authPayload === null || typeof authPayload !== 'object' || typeof (authPayload as Record<string, unknown>).login !== 'string') {
        return { kind: 'inconclusive', reason: 'github-auth-inconclusive', remoteRetention: 'retain' };
      }
      const inventory = await this.command.run(argsForRepositoryQuery(target, false));
      const payload = parseJson(inventory.stdout);
      if (payload !== null && isStructuredAbsence(payload)) return { kind: 'ready' };
      const repository = payload === null ? null : parseInspection(payload);
      if (repository !== null) return { kind: 'collision', repository, ownership: 'pre-existing' };
      return { kind: 'inconclusive', reason: 'repository-inventory-inconclusive', remoteRetention: 'retain' };
    } catch {
      return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
    }
  }

  async readback(target: GithubRepositoryTarget): Promise<GithubRepositoryReadbackResult> {
    validateTarget(target);
    try {
      const response = await this.command.run(argsForRepositoryQuery(target, true));
      const payload = parseJson(response.stdout);
      if (payload !== null && isStructuredAbsence(payload)) return { kind: 'absent' };
      const repository = payload === null ? null : parseInspection(payload);
      if (repository === null) return { kind: 'inconclusive', reason: 'repository-readback-inconclusive', remoteRetention: 'retain' };
      const treeResponse = await this.command.run(['api', TREE_ENDPOINT(target.owner, target.name)]);
      const treePayload = parseJson(treeResponse.stdout);
      if (treePayload === null || typeof treePayload !== 'object') return { kind: 'inconclusive', reason: 'repository-tree-inconclusive', remoteRetention: 'retain' };
      const tree = treePayload as GithubTreeResponse;
      if (tree.truncated !== false || !Array.isArray(tree.tree)) return { kind: 'inconclusive', reason: 'repository-tree-inconclusive', remoteRetention: 'retain' };
      const paths = new Set(tree.tree.filter((entry) => entry.type === 'blob' && typeof entry.path === 'string').map((entry) => entry.path as string));
      if (!repositoryMatchesTarget(target, repository)) return { kind: 'inconclusive', reason: 'initial-revision-mismatch', remoteRetention: 'retain' };
      if (target.initialRevision.requiredPaths.some((path) => !paths.has(path))) return { kind: 'inconclusive', reason: 'required-path-missing', remoteRetention: 'retain' };
      return { kind: 'present', repository };
    } catch {
      return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
    }
  }


  async provision(target: GithubRepositoryTarget): Promise<GithubRepositoryProvisionResult> {
    validateTarget(target);
    try {
      const preflight = await this.preflight(target);
      if (preflight.kind === 'collision') return preflight;
      if (preflight.kind === 'inconclusive') return inconclusive('preflight', preflight.reason);

      const create = await this.command.run([
        'repo', 'create', `${target.owner}/${target.name}`, `--${target.visibility}`,
        ...(target.description === '' ? [] : ['--description', target.description]),
        '--source', target.sourcePath, '--remote', 'origin', '--push',
      ]);
      if (create.exitCode !== 0) {
        const recovery = await this.readback(target);
        if (recovery.kind === 'present') return this.created(target, recovery.repository);
        return inconclusive(recovery.kind === 'inconclusive' ? 'readback' : 'create', recovery.kind === 'inconclusive' ? recovery.reason : 'create-failed-and-repository-absent');
      }

      const visibility = await this.command.run(['repo', 'edit', `${target.owner}/${target.name}`, '--enable-issues']);
      if (visibility.exitCode !== 0) return inconclusive('visibility', 'visibility-update-inconclusive');
      const readback = await this.readback(target);
      if (readback.kind === 'present') return this.created(target, readback.repository);
      if (readback.kind === 'inconclusive') return inconclusive('readback', readback.reason);
      return inconclusive('readback', 'repository-absent-after-create');
    } catch {
      return inconclusive('create', 'github-command-inconclusive');
    }
  }

  private created(target: GithubRepositoryTarget, repository: GithubRepositoryInspection): GithubRepositoryProvisionResult {
    return {
      kind: 'created',
      repository,
      ownership: 'created-by-configs',
      initialRevision: target.initialRevision,
      binding: {
        kind: 'github-repository',
        resourceId: repository.nameWithOwner,
        ownership: 'created-by-configs',
        fingerprint: known(repository.url),
      },
    };
  }
}

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { known } from '../../domain/facts';
import type {
  GithubRepositoryCommandPort,
  GithubRepositoryGitPort,
  GithubRepositoryPort,
  GithubRepositorySourcePort,
  GithubRepositorySourceValidation,
} from '../../application/ports';
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
    repository.initialCommit?.toLowerCase() === target.initialRevision.commit.toLowerCase();
}

function inconclusive(stage: 'preflight' | 'create' | 'visibility' | 'readback', reason: string): GithubRepositoryProvisionResult {
  return { kind: 'inconclusive', stage, reason, remoteRetention: 'retain' };
}
function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

interface SnapshotFile {
  readonly relativePath: string;
  readonly content: Uint8Array;
}

function snapshotDigest(files: readonly SnapshotFile[]): string {
  const hash = createHash('sha256');
  hash.update('agx.bootstrap-manifest/v1\0');
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const pathBytes = Buffer.from(file.relativePath, 'utf8');
    const pathLength = Buffer.allocUnsafe(8);
    pathLength.writeBigUInt64BE(BigInt(pathBytes.length));
    hash.update(pathLength);
    hash.update(pathBytes);
    const contentLength = Buffer.allocUnsafe(8);
    contentLength.writeBigUInt64BE(BigInt(file.content.byteLength));
    hash.update(contentLength);
    hash.update(file.content);
  }
  return hash.digest('hex');
}
export class FsGithubRepositorySourcePort implements GithubRepositorySourcePort {
  constructor(private readonly git: GithubRepositoryGitPort, private readonly sourceRoot?: string) {}
  async validate(sourcePath: string): Promise<GithubRepositorySourceValidation> {
    let snapshotPath: string | null = null;
    try {
      if (!path.isAbsolute(sourcePath)) return { kind: 'invalid', reason: 'source-path-not-absolute' };
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        return { kind: 'invalid', reason: 'source-path-is-not-a-regular-contained-directory' };
      }
      const root = await realpath(sourcePath);
      if (this.sourceRoot !== undefined) {
        const allowedRoot = await realpath(this.sourceRoot);
        if (!isContained(allowedRoot, root)) return { kind: 'invalid', reason: 'source-path-outside-source-root' };
      }
      const pending = [sourcePath];
      const files: SnapshotFile[] = [];
      while (pending.length > 0) {
        const directory = pending.pop();
        if (directory === undefined) continue;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const candidate = path.join(directory, entry.name);
          const info = await lstat(candidate);
          if (info.isSymbolicLink()) return { kind: 'invalid', reason: 'source-tree-contains-symlink-or-junction' };
          const resolved = await realpath(candidate);
          if (!isContained(root, resolved)) return { kind: 'invalid', reason: 'source-tree-escapes-source-root' };
          if (info.isDirectory()) {
            pending.push(candidate);
          } else if (info.isFile()) {
            files.push({
              relativePath: path.relative(sourcePath, candidate).split(path.sep).join('/'),
              content: await readFile(candidate),
            });
          } else {
            return { kind: 'invalid', reason: 'source-tree-contains-non-regular-entry' };
          }
        }
      }
      const contentDigest = snapshotDigest(files);
      snapshotPath = await mkdtemp(path.join(os.tmpdir(), 'configs-github-source-'));
      for (const file of files) {
        const destination = path.join(snapshotPath, ...file.relativePath.split('/'));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { mode: 0o400 });
      }
      const runGit = async (args: readonly string[]): Promise<{ readonly stdout: string }> => {
        const result = await this.git.run(args);
        if (result.exitCode !== 0) throw new Error('git staging command failed');
        return result;
      };
      await runGit(['-C', snapshotPath, 'init', '--initial-branch=main']);
      await runGit(['-C', snapshotPath, 'config', 'user.name', 'configs']);
      await runGit(['-C', snapshotPath, 'config', 'user.email', 'configs@users.noreply.github.com']);
      await runGit(['-C', snapshotPath, 'add', '--all']);
      await runGit(['-C', snapshotPath, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initialize repository']);
      const initialCommit = (await runGit(['-C', snapshotPath, 'rev-parse', 'HEAD'])).stdout.trim();
      if (!HEX_COMMIT.test(initialCommit)) throw new Error('invalid staged initial commit');
      await chmod(snapshotPath, 0o700);
      return { kind: 'valid', snapshotPath, contentDigest, initialCommit };
    } catch {
      if (snapshotPath !== null) await rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
      return { kind: 'invalid', reason: 'source-path-unreadable' };
    }
  }
}


export class GithubRepositoryAdapter implements GithubRepositoryPort {
  constructor(
    private readonly command: GithubRepositoryCommandPort,
    private readonly source: GithubRepositorySourcePort,
  ) {}

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
      if (inventory.exitCode !== 0) return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
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
      if (response.exitCode !== 0) return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
      const payload = parseJson(response.stdout);
      if (payload !== null && isStructuredAbsence(payload)) return { kind: 'absent' };
      const repository = payload === null ? null : parseInspection(payload);
      if (repository === null) return { kind: 'inconclusive', reason: 'repository-readback-inconclusive', remoteRetention: 'retain' };
      const treeResponse = await this.command.run(['api', TREE_ENDPOINT(target.owner, target.name)]);
      if (treeResponse.exitCode !== 0) return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
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
    let snapshotPath: string | null = null;
    try {
      const preflight = await this.preflight(target);
      if (preflight.kind === 'collision') return preflight;
      if (preflight.kind === 'inconclusive') return inconclusive('preflight', preflight.reason);
      const source = await this.source.validate(target.sourcePath);
      if (source.kind === 'invalid') return inconclusive('create', `source-path-invalid:${source.reason}`);
      snapshotPath = source.snapshotPath;
      if (source.contentDigest !== target.initialRevision.templateDigest) return inconclusive('create', 'source-content-digest-mismatch');
      const stagedTarget: GithubRepositoryTarget = {
        ...target,
        initialRevision: { ...target.initialRevision, commit: source.initialCommit },
      };

      const create = await this.command.run([
        'repo', 'create', `${target.owner}/${target.name}`, `--${target.visibility}`,
        ...(target.description === '' ? [] : ['--description', target.description]),
        '--source', source.snapshotPath, '--remote', 'origin', '--push',
      ]);
      if (create.exitCode !== 0) {
        const recovery = await this.readback(stagedTarget);
        if (recovery.kind === 'present') return this.created(stagedTarget, recovery.repository);
        return inconclusive(recovery.kind === 'inconclusive' ? 'readback' : 'create', recovery.kind === 'inconclusive' ? recovery.reason : 'create-failed-and-repository-absent');
      }

      const visibility = await this.command.run(['repo', 'edit', `${target.owner}/${target.name}`, '--enable-issues']);
      if (visibility.exitCode !== 0) return inconclusive('visibility', 'visibility-update-inconclusive');
      const readback = await this.readback(stagedTarget);
      if (readback.kind === 'present') return this.created(stagedTarget, readback.repository);
      if (readback.kind === 'inconclusive') return inconclusive('readback', readback.reason);
      return inconclusive('readback', 'repository-absent-after-create');
    } catch {
      return inconclusive('create', 'github-command-inconclusive');
    }
    finally {
      if (snapshotPath !== null) await rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
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
        ownership: 'unknown',
        remoteIdentity: repository.url,
        destructiveActions: 'denied',
      },
    };
  }
}

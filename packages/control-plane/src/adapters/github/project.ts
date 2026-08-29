import type { GithubProjectCommandPort, GithubProjectPort } from '../../application/ports';
import type {
  GithubProjectIdentity,
  GithubProjectPreflightResult,
  GithubProjectProvisionResult,
  GithubProjectReadbackResult,
  GithubProjectTarget,
} from '../../domain/github-project';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URL = /^https:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/projects\/([1-9][0-9]*)$/;

function parseJson(stdout: string): unknown | null {
  try { return JSON.parse(stdout); } catch { return null; }
}

function parseIdentity(value: unknown): GithubProjectIdentity | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const owner = record.owner;
  const ownerLogin = owner !== null && typeof owner === 'object' ? (owner as Record<string, unknown>).login : null;
  const parsedUrl = typeof record.url === 'string' ? URL.exec(record.url) : null;
  const projectOwner = parsedUrl?.[2];
  const projectNumber = parsedUrl?.[3];
  const visibility = record.public === true ? 'public' : record.public === false ? 'private' : null;
  if (typeof ownerLogin !== 'string' || typeof record.id !== 'string' || record.id.trim() === '' ||
      typeof record.number !== 'number' || !Number.isSafeInteger(record.number) || record.number <= 0 ||
      typeof record.title !== 'string' || record.title.trim() !== record.title || record.title === '' ||
      typeof record.url !== 'string' || parsedUrl === null || typeof projectOwner !== 'string' || typeof projectNumber !== 'string' || visibility === null ||
      projectNumber !== String(record.number) || projectOwner.toLowerCase() !== ownerLogin.toLowerCase()) return null;
  return {
    owner: ownerLogin,
    number: record.number,
    nodeId: record.id,
    url: record.url,
    title: record.title,
    visibility,
  };
}

interface GithubProjectLinkedNode {
  readonly nodeId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

function parseLinkedNode(value: unknown): GithubProjectLinkedNode | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const parsedUrl = typeof record.url === 'string' ? URL.exec(record.url) : null;
  const projectNumber = parsedUrl?.[3];
  if (typeof record.id !== 'string' || record.id.trim() === '' || typeof record.number !== 'number' ||
      !Number.isSafeInteger(record.number) || record.number <= 0 || typeof record.title !== 'string' ||
      record.title.trim() !== record.title || record.title === '' || typeof record.url !== 'string' ||
      parsedUrl === null || projectNumber !== String(record.number)) return null;
  return { nodeId: record.id, number: record.number, title: record.title, url: record.url };
}

function linkedNodeMatchesIdentity(node: GithubProjectLinkedNode, identity: GithubProjectIdentity): boolean {
  return node.nodeId === identity.nodeId && node.number === identity.number &&
    node.title === identity.title && node.url === identity.url;
}

function parseInventory(value: unknown): readonly GithubProjectIdentity[] | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.projects) || typeof record.totalCount !== 'number' || !Number.isSafeInteger(record.totalCount) || record.totalCount !== record.projects.length) return null;
  const projects = record.projects.map(parseIdentity);
  return projects.every((item): item is GithubProjectIdentity => item !== null) ? projects : null;
}
function validTarget(target: GithubProjectTarget): void {
  const repository = /^([^/]+)\/([^/]+)$/.exec(target.linkedRepository);
  const repositoryOwner = repository?.[1];
  const repositoryName = repository?.[2];
  if (!NAME.test(target.owner) || target.title.trim() !== target.title || target.title === '' || target.title.length > 256 ||
      (target.visibility !== 'private' && target.visibility !== 'public') || target.installationId.trim() === '' ||
      typeof repositoryOwner !== 'string' || typeof repositoryName !== 'string' ||
      repositoryOwner.toLowerCase() !== target.owner.toLowerCase() || !NAME.test(repositoryName)) {
    throw new Error('invalid GitHub Project target');
  }
}

function sameIdentity(left: GithubProjectIdentity, right: GithubProjectIdentity): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.number === right.number &&
    left.nodeId === right.nodeId && left.url === right.url && left.title === right.title;
}

function inconclusive(stage: 'preflight' | 'create' | 'visibility' | 'link' | 'readback', reason: string): GithubProjectProvisionResult {
  return { kind: 'inconclusive', stage, reason, remoteRetention: 'retain' };
}

function repositoryName(target: GithubProjectTarget): string {
  return target.linkedRepository.slice(target.linkedRepository.indexOf('/') + 1);
}

export class GithubProjectAdapter implements GithubProjectPort {
  constructor(private readonly command: GithubProjectCommandPort) {}

  async preflight(target: GithubProjectTarget): Promise<GithubProjectPreflightResult> {
    validTarget(target);
    try {
      const auth = await this.command.run(['auth', 'status', '--active', '--json', 'hosts']);
      const authPayload = parseJson(auth.stdout) as Record<string, unknown> | null;
      const hosts = authPayload?.hosts;
      const accounts = hosts !== null && typeof hosts === 'object' ? (hosts as Record<string, unknown>)['github.com'] : null;
      const scoped = Array.isArray(accounts) && accounts.some((account) => {
        if (account === null || typeof account !== 'object') return false;
        const item = account as Record<string, unknown>;
        return item.active === true && typeof item.scopes === 'string' && item.scopes.split(',').some((scope) => scope.trim() === 'project');
      });
      if (auth.exitCode !== 0 || !scoped) return { kind: 'inconclusive', reason: 'github-project-scope-inconclusive', remoteRetention: 'retain' };
      const inventory = await this.command.run(['project', 'list', '--owner', target.owner, '--closed', '--limit', '1000', '--format', 'json']);
      if (inventory.exitCode !== 0) return { kind: 'inconclusive', reason: 'project-inventory-inconclusive', remoteRetention: 'retain' };
      const projects = parseInventory(parseJson(inventory.stdout));
      if (projects === null) return { kind: 'inconclusive', reason: 'project-inventory-inconclusive', remoteRetention: 'retain' };
      const collision = projects.find((project) => project.owner.toLowerCase() === target.owner.toLowerCase() && project.title === target.title);
      return collision === undefined ? { kind: 'ready' } : { kind: 'collision', identity: collision, ownership: 'pre-existing' };
    } catch {
      return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
    }
  }

  async readback(target: GithubProjectTarget, number: number): Promise<GithubProjectReadbackResult> {
    validTarget(target);
    try {
      const projectResponse = await this.command.run(['project', 'view', String(number), '--owner', target.owner, '--format', 'json']);
      if (projectResponse.exitCode !== 0) return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
      const identity = parseIdentity(parseJson(projectResponse.stdout));
      if (identity === null) return { kind: 'inconclusive', reason: 'project-readback-inconclusive', remoteRetention: 'retain' };
      if (identity.number !== number || identity.owner.toLowerCase() !== target.owner.toLowerCase() || identity.title !== target.title) {
        return { kind: 'inconclusive', reason: 'project-identity-mismatch', remoteRetention: 'retain' };
      }
      if (identity.visibility !== target.visibility) return { kind: 'inconclusive', reason: 'project-visibility-mismatch', remoteRetention: 'retain' };
      const repositoryResponse = await this.command.run(['repo', 'view', target.linkedRepository, '--json', 'hasIssuesEnabled,projectsV2']);
      if (repositoryResponse.exitCode !== 0) return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
      const repository = parseJson(repositoryResponse.stdout);
      if (repository === null || typeof repository !== 'object') return { kind: 'inconclusive', reason: 'repository-readback-inconclusive', remoteRetention: 'retain' };
      const repositoryRecord = repository as Record<string, unknown>;
      if (repositoryRecord.hasIssuesEnabled !== true) return { kind: 'inconclusive', reason: 'issues-disabled', remoteRetention: 'retain' };
      const projectsV2 = repositoryRecord.projectsV2;
      const nodes = projectsV2 !== null && typeof projectsV2 === 'object' ? (projectsV2 as Record<string, unknown>).nodes : null;
      if (!Array.isArray(nodes)) return { kind: 'inconclusive', reason: 'project-link-inconclusive', remoteRetention: 'retain' };
      const linked = nodes.some((node) => {
        const linkedNode = parseLinkedNode(node);
        return linkedNode !== null && linkedNodeMatchesIdentity(linkedNode, identity);
      });
      return { kind: 'present', identity, hasIssues: true, linked };
    } catch {
      return { kind: 'inconclusive', reason: 'github-command-inconclusive', remoteRetention: 'retain' };
    }
  }

  async provision(target: GithubProjectTarget): Promise<GithubProjectProvisionResult> {
    validTarget(target);
    try {
      const preflight = await this.preflight(target);
      if (preflight.kind === 'collision') return preflight;
      if (preflight.kind === 'inconclusive') return inconclusive('preflight', preflight.reason);
      const create = await this.command.run(['project', 'create', '--owner', target.owner, '--title', target.title, '--format', 'json']);
      if (create.exitCode !== 0) return inconclusive('create', 'project-create-inconclusive');
      let identity = parseIdentity(parseJson(create.stdout));
      if (identity === null || identity.owner.toLowerCase() !== target.owner.toLowerCase() || identity.title !== target.title) return inconclusive('create', 'project-identity-mismatch');
      if (identity.visibility !== target.visibility) {
        const edit = await this.command.run(['project', 'edit', String(identity.number), '--owner', target.owner, '--visibility', target.visibility.toUpperCase(), '--format', 'json']);
        if (edit.exitCode !== 0) return inconclusive('visibility', 'project-visibility-inconclusive');
        const edited = parseIdentity(parseJson(edit.stdout));
        if (edited === null || !sameIdentity(edited, identity) || edited.visibility !== target.visibility) return inconclusive('visibility', 'project-visibility-mismatch');
        identity = edited;
      }
      const link = await this.command.run(['project', 'link', String(identity.number), '--owner', target.owner, '--repo', repositoryName(target)]);
      const readback = await this.readback(target, identity.number);
      if (readback.kind === 'present' && readback.linked && readback.identity.visibility === target.visibility && sameIdentity(readback.identity, identity)) {
        return this.created(readback.identity);
      }
      if (link.exitCode !== 0) return inconclusive('link', 'project-link-inconclusive');
      return inconclusive('readback', readback.kind === 'inconclusive' ? readback.reason : 'project-link-missing');
    } catch {
      return inconclusive('create', 'github-command-inconclusive');
    }
  }

  private created(identity: GithubProjectIdentity): GithubProjectProvisionResult {
    return {
      kind: 'created',
      identity,
      ownership: 'created-by-configs',
      linked: true,
      binding: { kind: 'github-project', resourceId: identity.nodeId, ownership: 'unknown', remoteIdentity: identity.url, destructiveActions: 'denied' },
    };
  }
}

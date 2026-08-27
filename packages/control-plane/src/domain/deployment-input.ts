import path from 'node:path';
import type { DeploymentPreflightInput } from '../application/deployment-preflight';
import type { GithubProjectTarget } from './github-project';
import type { GithubRepositoryTarget } from './github-repository';
import type { MulticaSubject, MulticaSubjectKind } from './multica';
import type { ProviderActivationTarget, ProviderName, ProviderPluginTarget } from './provider';

export const DEPLOYMENT_INPUT_SCHEMA_VERSION = 1 as const;
export const MAX_DEPLOYMENT_INPUT_BYTES = 1_048_576;
const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_MESSAGE = 160;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const URL_PROTOCOLS = new Set(['http:', 'https:']);
const MULTICA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type JsonRecord = Record<string, unknown>;
export interface DeploymentInputDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export type DeploymentInputResult =
  | { readonly kind: 'accepted'; readonly input: DeploymentPreflightInput; readonly sourceRoot: string; readonly sourceValidation: 'deferred-realpath-required' }
  | { readonly kind: 'rejected'; readonly diagnostics: readonly DeploymentInputDiagnostic[] };

function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasOnlyKeys(value: JsonRecord, keys: readonly string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function cleanMessage(message: string): string { return message.slice(0, MAX_DIAGNOSTIC_MESSAGE); }
function isCleanString(value: unknown, max = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function isId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function isAbsolutePath(value: unknown): value is string { return isCleanString(value, 4096) && path.isAbsolute(value); }
function isContained(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function isUrl(value: unknown): value is string { if (!isCleanString(value, 2048)) return false; try { const parsed = new URL(value); return URL_PROTOCOLS.has(parsed.protocol) && parsed.hostname !== '' && parsed.username === '' && parsed.password === ''; } catch { return false; } }
function isRelativePath(value: unknown): value is string { if (!isCleanString(value, 512) || path.isAbsolute(value)) return false; const normalized = value.replace(/\\/g, '/'); return normalized.split('/').every((part) => part !== '' && part !== '.' && part !== '..'); }

/** Returns true for malformed JSON, duplicate object keys, or trailing bytes. */
function malformedJson(value: string): boolean {
  let index = 0;
  const whitespace = (): void => { while (/\s/.test(value[index] ?? '')) index += 1; };
  const stringValue = (): boolean => {
    if (value[index] !== '"') return false;
    index += 1;
    while (index < value.length) {
      if (value[index] === '\\') { index += 2; continue; }
      if (value[index++] === '"') return true;
    }
    return false;
  };
  const parseValue = (): boolean => {
    whitespace();
    if (value[index] === '{') {
      index += 1; const keys = new Set<string>(); whitespace();
      if (value[index] === '}') { index += 1; return true; }
      while (index < value.length) {
        const start = index;
        if (!stringValue()) return false;
        let key: string;
        try { key = JSON.parse(value.slice(start, index)) as string; } catch { return false; }
        if (keys.has(key)) return false; keys.add(key); whitespace();
        if (value[index++] !== ':') return false;
        if (!parseValue()) return false;
        whitespace();
        if (value[index] === '}') { index += 1; return true; }
        if (value[index++] !== ',') return false;
        whitespace();
      }
      return false;
    }
    if (value[index] === '[') {
      index += 1; whitespace();
      if (value[index] === ']') { index += 1; return true; }
      while (index < value.length) {
        if (!parseValue()) return false; whitespace();
        if (value[index] === ']') { index += 1; return true; }
        if (value[index++] !== ',') return false; whitespace();
      }
      return false;
    }
    if (value[index] === '"') return stringValue();
    const literal = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(value.slice(index));
    if (literal === null) return false;
    index += literal[0].length; return true;
  };
  if (!parseValue()) return true; whitespace(); return index !== value.length;
}

function parseJson(value: string | Uint8Array): { readonly value?: unknown; readonly error?: string } {
  let text: string;
  try {
    if (typeof value === 'string') {
      if (new TextEncoder().encode(value).byteLength > MAX_DEPLOYMENT_INPUT_BYTES) return { error: 'input-too-large' };
      text = value;
    } else {
      if (value.byteLength > MAX_DEPLOYMENT_INPUT_BYTES) return { error: 'input-too-large' };
      text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    }
  } catch { return { error: 'invalid-utf8' }; }
  if (malformedJson(text)) return { error: 'invalid-json' };
  try { return { value: JSON.parse(text) }; } catch { return { error: 'invalid-json' }; }
}

export function parseDeploymentInput(value: string | Uint8Array): DeploymentInputResult {
  const parsed = parseJson(value);
  if (parsed.error !== undefined) return { kind: 'rejected', diagnostics: [{ code: parsed.error, path: '$', message: cleanMessage(`deployment input ${parsed.error}`) }] };
  const diagnostics: DeploymentInputDiagnostic[] = [];
  const reject = (code: string, fieldPath: string, message: string): void => { if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push({ code, path: fieldPath, message: cleanMessage(message) }); };
  const root = parsed.value;
  if (!isRecord(root)) return { kind: 'rejected', diagnostics: [{ code: 'invalid-root', path: '$', message: 'deployment input must be a JSON object' }] };
  const rootKeys = ['schemaVersion', 'sourceRoot', 'deploymentId', 'operationId', 'revisionId', 'repositories', 'project', 'providers', 'multicaSubjects'] as const;
  for (const key of Object.keys(root)) if (!rootKeys.includes(key as typeof rootKeys[number])) reject('unknown-field', `$.${key}`, 'unknown deployment input field');
  for (const key of ['schemaVersion', 'sourceRoot', 'deploymentId', 'operationId', 'revisionId', 'repositories', 'project', 'providers'] as const) if (!(key in root)) reject('missing-field', `$.${key}`, 'required deployment input field is missing');
  if (root.schemaVersion !== DEPLOYMENT_INPUT_SCHEMA_VERSION) reject('unsupported-schema-version', '$.schemaVersion', 'unsupported deployment input schema version');
  const sourceRoot = root.sourceRoot;
  if (!isAbsolutePath(sourceRoot)) reject('invalid-source-root', '$.sourceRoot', 'sourceRoot must be an absolute path');
  const deploymentId = root.deploymentId;
  const operationId = root.operationId;
  const revisionId = root.revisionId;
  if (!isId(deploymentId)) reject('invalid-deployment-id', '$.deploymentId', 'deploymentId is malformed');
  if (!isId(operationId)) reject('invalid-operation-id', '$.operationId', 'operationId is malformed');
  if (!isId(revisionId)) reject('invalid-revision-id', '$.revisionId', 'revisionId is malformed');
  const repositories: GithubRepositoryTarget[] = [];
  const repositoryIdentities = new Set<string>();
  if (!Array.isArray(root.repositories)) reject('invalid-repositories', '$.repositories', 'repositories must be an array');
  for (const [index, candidate] of (Array.isArray(root.repositories) ? root.repositories : []).entries()) {
    const fieldPath = `$.repositories[${index}]`;
    if (!isRecord(candidate)) { reject('invalid-repository', fieldPath, 'repository target must be an object'); continue; }
    const keys = ['owner', 'name', 'visibility', 'description', 'sourcePath', 'initialRevision'] as const;
    for (const key of Object.keys(candidate)) if (!keys.includes(key as typeof keys[number])) reject('unknown-field', `${fieldPath}.${key}`, 'unknown repository field');
    const owner = candidate.owner; const name = candidate.name; const visibility = candidate.visibility; const description = candidate.description; const sourcePath = candidate.sourcePath; const initial = candidate.initialRevision;
    if (!isId(owner)) reject('invalid-repository-owner', `${fieldPath}.owner`, 'repository owner is malformed');
    if (!isId(name)) reject('invalid-repository-name', `${fieldPath}.name`, 'repository name is malformed');
    if (visibility !== 'private' && visibility !== 'public') reject('invalid-repository-visibility', `${fieldPath}.visibility`, 'repository visibility is invalid');
    if (!isCleanString(description, 1024)) reject('invalid-repository-description', `${fieldPath}.description`, 'repository description is invalid');
    if (!isAbsolutePath(sourcePath)) reject('invalid-source-path', `${fieldPath}.sourcePath`, 'repository sourcePath must be absolute');
    else if (isAbsolutePath(sourceRoot) && !isContained(sourceRoot, sourcePath)) reject('source-path-outside-root', `${fieldPath}.sourcePath`, 'repository sourcePath is outside sourceRoot');
    if (!isRecord(initial)) { reject('invalid-initial-revision', `${fieldPath}.initialRevision`, 'initialRevision must be an object'); continue; }
    for (const key of Object.keys(initial)) if (!['commit', 'templateVersion', 'templateDigest', 'requiredPaths'].includes(key)) reject('unknown-field', `${fieldPath}.initialRevision.${key}`, 'unknown initial revision field');
    if (!HEX40.test(String(initial.commit ?? ''))) reject('invalid-commit', `${fieldPath}.initialRevision.commit`, 'initial revision commit is malformed');
    if (!isCleanString(initial.templateVersion, 128)) reject('invalid-template-version', `${fieldPath}.initialRevision.templateVersion`, 'template version is invalid');
    if (!HEX64.test(String(initial.templateDigest ?? ''))) reject('invalid-template-digest', `${fieldPath}.initialRevision.templateDigest`, 'initial revision digest is malformed');
    if (!Array.isArray(initial.requiredPaths) || initial.requiredPaths.length === 0 || !initial.requiredPaths.every(isRelativePath)) reject('invalid-required-path', `${fieldPath}.initialRevision.requiredPaths`, 'requiredPaths must be a non-empty safe relative-path array');
    if (isId(owner) && isId(name)) {
      const identity = `${owner}/${name}`.toLowerCase();
      if (repositoryIdentities.has(identity)) reject('duplicate-repository', fieldPath, 'duplicate repository identity');
      repositoryIdentities.add(identity);
    }
    if (isId(owner) && isId(name) && (visibility === 'private' || visibility === 'public') && isCleanString(description, 1024) && isAbsolutePath(sourcePath) && isRecord(initial) && HEX40.test(String(initial.commit ?? '')) && isCleanString(initial.templateVersion, 128) && HEX64.test(String(initial.templateDigest ?? '')) && Array.isArray(initial.requiredPaths) && initial.requiredPaths.length > 0 && initial.requiredPaths.every(isRelativePath)) repositories.push({ owner, name, visibility, description, sourcePath, initialRevision: { commit: initial.commit as string, templateVersion: initial.templateVersion, templateDigest: initial.templateDigest as string, requiredPaths: initial.requiredPaths as string[] } });
  }
  let project: GithubProjectTarget | null = null;
  if (!isRecord(root.project)) reject('invalid-project', '$.project', 'project must be an object');
  else {
    const candidate = root.project; const keys = ['owner', 'title', 'visibility', 'linkedRepository', 'installationId'] as const;
    for (const key of Object.keys(candidate)) if (!keys.includes(key as typeof keys[number])) reject('unknown-field', `$.project.${key}`, 'unknown project field');
    if (!isId(candidate.owner)) reject('invalid-project-owner', '$.project.owner', 'project owner is malformed');
    if (!isCleanString(candidate.title, 256)) reject('invalid-project-title', '$.project.title', 'project title is invalid');
    if (candidate.visibility !== 'private' && candidate.visibility !== 'public') reject('invalid-project-visibility', '$.project.visibility', 'project visibility is invalid');
    if (!isCleanString(candidate.linkedRepository, 256) || !/^([^/]+)\/([^/]+)$/.test(candidate.linkedRepository)) reject('invalid-linked-repository', '$.project.linkedRepository', 'linked repository is malformed');
    if (!isId(candidate.installationId)) reject('invalid-installation-id', '$.project.installationId', 'installationId is malformed');
    const linked = typeof candidate.linkedRepository === 'string' ? /^([^/]+)\/([^/]+)$/.exec(candidate.linkedRepository) : null;
    if (linked !== null && isId(candidate.owner) && linked[1]!.toLowerCase() !== candidate.owner.toLowerCase()) reject('linked-repository-owner-mismatch', '$.project.linkedRepository', 'linked repository owner must match project owner');
    if (isId(candidate.owner) && isCleanString(candidate.title, 256) && (candidate.visibility === 'private' || candidate.visibility === 'public') && isCleanString(candidate.linkedRepository, 256) && /^([^/]+)\/([^/]+)$/.test(candidate.linkedRepository) && isId(candidate.installationId)) project = candidate as unknown as GithubProjectTarget;
  }
  const providers: ProviderActivationTarget[] = [];
  const providerIdentities = new Set<string>();
  if (!Array.isArray(root.providers)) reject('invalid-providers', '$.providers', 'providers must be an array');
  for (const [index, candidate] of (Array.isArray(root.providers) ? root.providers : []).entries()) {
    const fieldPath = `$.providers[${index}]`;
    if (!isRecord(candidate)) { reject('invalid-provider', fieldPath, 'provider target must be an object'); continue; }
    for (const key of Object.keys(candidate)) if (!['provider', 'marketplaceSource', 'plugins'].includes(key)) reject('unknown-field', `${fieldPath}.${key}`, 'unknown provider field');
    if (candidate.provider !== 'codex' && candidate.provider !== 'claude') reject('invalid-provider', `${fieldPath}.provider`, 'provider name is invalid');
    if (!isUrl(candidate.marketplaceSource) && !isAbsolutePath(candidate.marketplaceSource)) reject('invalid-marketplace-url', `${fieldPath}.marketplaceSource`, 'marketplaceSource must be an absolute URL or path');
    if (!Array.isArray(candidate.plugins)) reject('invalid-plugins', `${fieldPath}.plugins`, 'plugins must be an array');
    const plugins: ProviderPluginTarget[] = [];
    for (const [pluginIndex, plugin] of (Array.isArray(candidate.plugins) ? candidate.plugins : []).entries()) {
      const pluginPath = `${fieldPath}.plugins[${pluginIndex}]`;
      if (!isRecord(plugin) || !hasOnlyKeys(plugin, ['name', 'version', 'enabled']) || !isId(plugin.name) || !isCleanString(plugin.version, 128) || typeof plugin.enabled !== 'boolean') { reject('invalid-plugin', pluginPath, 'provider plugin target is invalid'); continue; }
      plugins.push({ name: plugin.name, version: plugin.version, enabled: plugin.enabled });
    }
    if ((candidate.provider === 'codex' || candidate.provider === 'claude') && (isUrl(candidate.marketplaceSource) || isAbsolutePath(candidate.marketplaceSource)) && Array.isArray(candidate.plugins) && plugins.length === candidate.plugins.length) {
      const identity = candidate.provider.toLowerCase();
      if (providerIdentities.has(identity)) reject('duplicate-provider', fieldPath, 'duplicate provider identity');
      providerIdentities.add(identity);
      providers.push({ provider: candidate.provider as ProviderName, marketplaceSource: candidate.marketplaceSource as string, plugins });
    }
  }
  let multicaSubjects: MulticaSubject[] | undefined;
  if (root.multicaSubjects !== undefined) {
    if (!Array.isArray(root.multicaSubjects)) reject('invalid-multica-subjects', '$.multicaSubjects', 'multicaSubjects must be an array');
    else {
      multicaSubjects = [];
      for (const [index, candidate] of root.multicaSubjects.entries()) {
        const fieldPath = `$.multicaSubjects[${index}]`;
        if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['kind', 'id']) || !['workspace', 'runtime', 'agent'].includes(String(candidate.kind)) || typeof candidate.id !== 'string' || !MULTICA_UUID.test(candidate.id)) { reject('invalid-multica-subject', fieldPath, 'Multica subject must contain a valid UUID'); continue; }
        multicaSubjects.push({ kind: candidate.kind as MulticaSubjectKind, id: candidate.id });
      }
    }
  }
  if (diagnostics.length > 0 || !isAbsolutePath(sourceRoot) || !isId(deploymentId) || !isId(operationId) || !isId(revisionId) || project === null) return { kind: 'rejected', diagnostics };
  return { kind: 'accepted', input: { sourceRoot, deploymentId, operationId, revisionId, repositories, project, providers, ...(multicaSubjects === undefined ? {} : { multicaSubjects }) }, sourceRoot, sourceValidation: 'deferred-realpath-required' };
}

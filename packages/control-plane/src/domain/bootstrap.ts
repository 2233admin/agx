import { createHash } from 'node:crypto';

export const BOOTSTRAP_TEMPLATE_SET_VERSION = 'bootstrap-20260819.1';
export const BOOTSTRAP_TEMPLATE_SET_CONTENT_SHA256 = '66b4db310377e9dfb173b3e39f4bc54665313ad2c4f6ee80602e941ea453e005';

export type BootstrapTemplateKind = 'agent-control' | 'agent-contracts';
export interface BootstrapTemplateFile { readonly path: string; readonly content: string; }
export interface BootstrapTemplateSource {
  readonly kind: BootstrapTemplateKind;
  readonly templateVersion: 'agent-control/v1' | 'agent-contracts/v1';
  readonly templateSetVersion: string;
  readonly templateSetContentSHA256: string;
  readonly files: readonly BootstrapTemplateFile[];
}
export interface BootstrapParams { readonly owner: string; readonly repository: string; readonly pluginSource: string; }
export interface BootstrapRenderedFile { readonly path: string; readonly content: string; }
export interface BootstrapRendered {
  readonly kind: BootstrapTemplateKind;
  readonly templateVersion: BootstrapTemplateSource['templateVersion'];
  readonly templateSetVersion: string;
  readonly templateSetContentSHA256: string;
  readonly digest: string;
  readonly files: readonly BootstrapRenderedFile[];
}
export interface BootstrapTreeEntry { readonly path: string; readonly kind: 'file' | 'directory' | 'symlink'; readonly content?: string; }
export type BootstrapTreeDecision =
  | { readonly kind: 'create' }
  | { readonly kind: 'already-exact' }
  | { readonly kind: 'reject'; readonly reason: 'invalid-rendered-tree' | 'drift' | 'non-regular-target' | 'unsafe-existing-path' };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const SOURCE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const PLACEHOLDER = '@@AGX_';
const SHA256 = /^[a-f0-9]{64}$/;
const LIVE_STATE = ['.git', 'work/records/', 'work/history/', 'run-packages/', '.cap/', 'src/agent_system/', 'plugins/', 'entrypoints/'];

function normalizePath(value: string): string | null {
  if (value === '' || value.includes('\\') || value.startsWith('/')) return null;
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  const clean = parts.join('/');
  if (clean !== value || clean === '.git' || clean.startsWith('.git/')) return null;
  if (LIVE_STATE.some((prefix) => clean === prefix || clean.startsWith(prefix))) return null;
  return clean;
}

function manifestDigest(files: readonly BootstrapRenderedFile[]): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from('agx.bootstrap-manifest/v1\0'));
  for (const file of files) {
    const pathBytes = Buffer.from(file.path);
    const contentBytes = Buffer.from(file.content);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(pathBytes.length)); hash.update(length); hash.update(pathBytes);
    length.writeBigUInt64BE(BigInt(contentBytes.length)); hash.update(length); hash.update(contentBytes);
  }
  return hash.digest('hex');
}

function expectedVersion(kind: BootstrapTemplateKind): BootstrapTemplateSource['templateVersion'] {
  return kind === 'agent-control' ? 'agent-control/v1' : 'agent-contracts/v1';
}

function validateParams(params: BootstrapParams): boolean {
  return OWNER.test(params.owner) && REPOSITORY.test(params.repository) && params.repository !== '.' && params.repository !== '..' && SOURCE.test(params.pluginSource);
}

export function renderBootstrap(source: BootstrapTemplateSource, params: BootstrapParams): BootstrapRendered {
  if (source.templateSetVersion !== BOOTSTRAP_TEMPLATE_SET_VERSION || source.templateSetContentSHA256 !== BOOTSTRAP_TEMPLATE_SET_CONTENT_SHA256 || source.templateVersion !== expectedVersion(source.kind) || !SHA256.test(source.templateSetContentSHA256)) throw new Error('invalid bootstrap template identity');
  if (!validateParams(params)) throw new Error('invalid bootstrap parameters');
  const targetSlug = `${params.owner}/${params.repository}`;
  const replacements: readonly [string, string][] = [
    ['@@AGX_OWNER@@', params.owner], ['@@AGX_REPOSITORY@@', params.repository], ['@@AGX_TARGET_SLUG@@', targetSlug],
    ['@@AGX_TARGET_URL@@', `https://github.com/${targetSlug}`], ['@@AGX_PLUGIN_SOURCE@@', params.pluginSource], ['@@AGX_PLUGIN_SOURCE_URL@@', `https://github.com/${params.pluginSource}`],
  ];
  const seen = new Set<string>();
  const files: BootstrapRenderedFile[] = [];
  for (const file of source.files) {
    const path = normalizePath(file.path);
    if (path === null || seen.has(path)) throw new Error('invalid bootstrap template path');
    seen.add(path);
    let content = file.content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    for (const [placeholder, replacement] of replacements) content = content.replaceAll(placeholder, replacement);
    if (content.includes(PLACEHOLDER) || content.includes('\0')) throw new Error('invalid bootstrap template content');
    files.push({ path, content });
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (files.length === 0) throw new Error('bootstrap template is empty');
  return { kind: source.kind, templateVersion: source.templateVersion, templateSetVersion: source.templateSetVersion, templateSetContentSHA256: source.templateSetContentSHA256, digest: manifestDigest(files), files };
}

function validateRendered(rendered: BootstrapRendered): boolean {
  if (rendered.templateVersion !== expectedVersion(rendered.kind) || rendered.templateSetVersion !== BOOTSTRAP_TEMPLATE_SET_VERSION || rendered.templateSetContentSHA256 !== BOOTSTRAP_TEMPLATE_SET_CONTENT_SHA256 || !SHA256.test(rendered.digest)) return false;
  let previous = '';
  for (const file of rendered.files) {
    const path = normalizePath(file.path);
    if (path === null || path <= previous || file.content.includes('\r') || file.content.includes(PLACEHOLDER) || file.content.includes('\0')) return false;
    previous = path;
  }
  return rendered.digest === manifestDigest(rendered.files);
}

export function decideBootstrapTree(rendered: BootstrapRendered, existing: readonly BootstrapTreeEntry[]): BootstrapTreeDecision {
  const byPath = new Map<string, BootstrapTreeEntry>();
  for (const entry of existing) {
    const path = normalizePath(entry.path);
    if (path === null) return { kind: 'reject', reason: 'unsafe-existing-path' };
    if (byPath.has(path)) return { kind: 'reject', reason: 'unsafe-existing-path' };
    byPath.set(path, entry);
  }
  let exact = true;
  for (const file of rendered.files) {
    const entry = byPath.get(file.path);
    if (entry === undefined) { exact = false; continue; }
    if (entry.kind !== 'file' && entry.kind !== 'symlink') return { kind: 'reject', reason: 'non-regular-target' };
    if (entry.kind === 'symlink' || entry.content !== file.content) return { kind: 'reject', reason: entry.kind === 'symlink' ? 'non-regular-target' : 'drift' };
  }
  return exact ? { kind: 'already-exact' } : { kind: 'create' };
}

import type {
  ClaudeProviderCommandPort,
  CodexProviderCommandPort,
  ProviderActivationPort,
  ProviderInventoryPort,
} from '../../application/ports';
import type {
  ProviderActivationResult,
  ProviderActivationTarget,
  ProviderInventory,
  ProviderInventoryResult,
  ProviderMarketplace,
  ProviderOwnershipRecord,
  ProviderPlugin,
  ProviderRevokeResult,
} from '../../domain/provider';

const MARKETPLACE = 'agent-plugins';

function parseJson(stdout: string): unknown | null {
  try { return JSON.parse(stdout); } catch { return null; }
}

function canonicalSource(value: string): string {
  return value.trim().replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sameSource(actual: string | null, expected: string): boolean {
  return actual !== null && actual.trim() !== '' && canonicalSource(actual) === canonicalSource(expected);
}

function inconclusive(reason: string): { readonly kind: 'inconclusive'; readonly reason: string } {
  return { kind: 'inconclusive', reason };
}

function providerNameValid(value: string): boolean {
  return value.trim() !== '' && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseCodexInventory(marketplaceJSON: unknown, pluginJSON: unknown): ProviderInventory | null {
  if (marketplaceJSON === null || typeof marketplaceJSON !== 'object' || pluginJSON === null || typeof pluginJSON !== 'object') return null;
  const marketplaces = (marketplaceJSON as Record<string, unknown>).marketplaces;
  const installed = (pluginJSON as Record<string, unknown>).installed;
  if (!Array.isArray(marketplaces) || !Array.isArray(installed)) return null;
  let marketplace: ProviderMarketplace = { present: false, sourceType: null, source: null };
  for (const item of marketplaces) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (record.name !== MARKETPLACE) continue;
    if (typeof record.root !== 'string' || record.root.trim() === '') return null;
    const sourceRecord = record.marketplaceSource;
    let sourceType: string | null = 'local';
    let source = record.root;
    if (sourceRecord !== undefined && sourceRecord !== null) {
      if (typeof sourceRecord !== 'object') return null;
      const typed = sourceRecord as Record<string, unknown>;
      if (typeof typed.sourceType !== 'string' || typeof typed.source !== 'string' || typed.source.trim() === '') return null;
      sourceType = typed.sourceType;
      source = typed.source;
    }
    marketplace = { present: true, sourceType, source };
    break;
  }
  const plugins: ProviderPlugin[] = [];
  for (const item of installed) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (record.marketplaceName !== MARKETPLACE || record.installed !== true) continue;
    if (typeof record.name !== 'string' || !providerNameValid(record.name) || typeof record.version !== 'string' || typeof record.enabled !== 'boolean') return null;
    plugins.push({ name: record.name, version: record.version, enabled: record.enabled });
  }
  return { provider: 'codex', marketplace, plugins };
}

function parseClaudeInventory(marketplaceJSON: unknown, pluginJSON: unknown): ProviderInventory | null {
  if (!Array.isArray(marketplaceJSON) || !Array.isArray(pluginJSON)) return null;
  let marketplace: ProviderMarketplace = { present: false, sourceType: null, source: null };
  for (const item of marketplaceJSON) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (record.name !== MARKETPLACE) continue;
    const source = [record.path, record.repo, record.url, record.installLocation].find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? null;
    if (source === null || typeof record.source !== 'string') return null;
    marketplace = { present: true, sourceType: record.source, source };
    break;
  }
  const plugins: ProviderPlugin[] = [];
  for (const item of pluginJSON) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.endsWith(`@${MARKETPLACE}`) || record.scope !== 'user') continue;
    const name = record.id.slice(0, -(`@${MARKETPLACE}`).length);
    if (!providerNameValid(name) || typeof record.version !== 'string' || typeof record.enabled !== 'boolean') return null;
    plugins.push({ name, version: record.version, enabled: record.enabled });
  }
  return { provider: 'claude', marketplace, plugins };
}

abstract class ProviderAdapterBase<Command extends { available(): Promise<boolean>; run(args: readonly string[]): Promise<{ readonly stdout: string; readonly exitCode: number | null }> }> implements ProviderInventoryPort, ProviderActivationPort {
  protected abstract readonly provider: 'codex' | 'claude';
  protected abstract readonly command: Command;
  protected abstract parseInventory(marketplaceJSON: unknown, pluginJSON: unknown): ProviderInventory | null;
  protected abstract inspectArgs(): readonly [readonly string[], readonly string[]];
  protected abstract addMarketplaceArgs(source: string): readonly string[];
  protected abstract removeMarketplaceArgs(): readonly string[];
  protected abstract installPluginArgs(name: string): readonly string[];
  protected abstract removePluginArgs(name: string): readonly string[];

  async inspect(): Promise<ProviderInventoryResult> {
    try {
      if (!(await this.command.available())) return inconclusive('provider-cli-unavailable');
      const [marketplaceArgs, pluginArgs] = this.inspectArgs();
      const marketplace = await this.command.run(marketplaceArgs);
      const plugins = await this.command.run(pluginArgs);
      if (marketplace.exitCode !== 0 || plugins.exitCode !== 0) return inconclusive('provider-inventory-inconclusive');
      const inventory = this.parseInventory(parseJson(marketplace.stdout), parseJson(plugins.stdout));
      return inventory === null ? inconclusive('provider-inventory-inconclusive') : { kind: 'observed', inventory };
    } catch {
      return inconclusive('provider-inventory-inconclusive');
    }
  }

  async activate(target: ProviderActivationTarget): Promise<ProviderActivationResult> {
    if (target.provider !== this.provider || target.marketplaceSource.trim() === '' || target.plugins.some((plugin) => !providerNameValid(plugin))) return inconclusive('invalid-provider-activation-target');
    const before = await this.inspect();
    if (before.kind === 'inconclusive') return before;
    if (before.inventory.marketplace.present && !sameSource(before.inventory.marketplace.source, target.marketplaceSource)) {
      return { kind: 'collision', reason: 'different-marketplace-source', actualSource: before.inventory.marketplace.source ?? '(unknown)' };
    }
    let marketplaceOwnership: ProviderOwnershipRecord['marketplace'] = before.inventory.marketplace.present ? 'pre-existing' : 'created-by-configs';
    if (!before.inventory.marketplace.present) {
      try {
        const result = await this.command.run(this.addMarketplaceArgs(target.marketplaceSource));
        if (result.exitCode !== 0) return inconclusive('marketplace-activation-inconclusive');
      } catch {
        return inconclusive('marketplace-activation-inconclusive');
      }
    }
    const existing = new Set(before.inventory.plugins.map((plugin) => plugin.name));
    const ownedPlugins: string[] = [];
    for (const plugin of target.plugins) {
      if (existing.has(plugin)) continue;
      try {
        const result = await this.command.run(this.installPluginArgs(plugin));
        if (result.exitCode !== 0) return inconclusive(`plugin-activation-inconclusive:${plugin}`);
        ownedPlugins.push(plugin);
      } catch {
        return inconclusive(`plugin-activation-inconclusive:${plugin}`);
      }
    }
    const after = await this.inspect();
    if (after.kind === 'inconclusive') return after;
    return { kind: 'activated', inventory: after.inventory, ownership: { marketplace: marketplaceOwnership, marketplaceSource: target.marketplaceSource, plugins: ownedPlugins } };
  }

  async revoke(target: ProviderActivationTarget, ownership: ProviderOwnershipRecord): Promise<ProviderRevokeResult> {
    if (target.provider !== this.provider) return inconclusive('invalid-provider-revoke-target');
    const current = await this.inspect();
    if (current.kind === 'inconclusive') return current;
    if (ownership.marketplace === 'unknown') return { kind: 'preserved', reason: 'ownership-unknown' };
    if (!sameSource(current.inventory.marketplace.source, ownership.marketplaceSource)) {
      if (current.inventory.marketplace.present && current.inventory.marketplace.source !== null) return { kind: 'collision', reason: 'marketplace-source-changed', actualSource: current.inventory.marketplace.source };
      return inconclusive('marketplace-source-inconclusive');
    }
    for (const plugin of ownership.plugins) {
      if (!current.inventory.plugins.some((item) => item.name === plugin)) continue;
      try {
        const result = await this.command.run(this.removePluginArgs(plugin));
        if (result.exitCode !== 0) return inconclusive(`plugin-revoke-inconclusive:${plugin}`);
      } catch {
        return inconclusive(`plugin-revoke-inconclusive:${plugin}`);
      }
    }
    if (ownership.marketplace === 'pre-existing') return { kind: 'preserved', reason: 'marketplace-pre-existing' };
    try {
      const result = await this.command.run(this.removeMarketplaceArgs());
      if (result.exitCode !== 0) return inconclusive('marketplace-revoke-inconclusive');
      return { kind: 'revoked', ownership };
    } catch {
      return inconclusive('marketplace-revoke-inconclusive');
    }
  }
}

export class CodexProviderAdapter extends ProviderAdapterBase<CodexProviderCommandPort> {
  protected readonly provider = 'codex' as const;
  protected readonly command: CodexProviderCommandPort;
  constructor(command: CodexProviderCommandPort) { super(); this.command = command; }
  protected parseInventory(marketplaceJSON: unknown, pluginJSON: unknown): ProviderInventory | null { return parseCodexInventory(marketplaceJSON, pluginJSON); }
  protected inspectArgs(): readonly [readonly string[], readonly string[]] { return [['plugin', 'marketplace', 'list', '--json'], ['plugin', 'list', '--json']]; }
  protected addMarketplaceArgs(source: string): readonly string[] { return ['plugin', 'marketplace', 'add', source, '--json']; }
  protected removeMarketplaceArgs(): readonly string[] { return ['plugin', 'marketplace', 'remove', MARKETPLACE, '--json']; }
  protected installPluginArgs(name: string): readonly string[] { return ['plugin', 'add', `${name}@${MARKETPLACE}`, '--json']; }
  protected removePluginArgs(name: string): readonly string[] { return ['plugin', 'remove', `${name}@${MARKETPLACE}`, '--json']; }
}

export class ClaudeProviderAdapter extends ProviderAdapterBase<ClaudeProviderCommandPort> {
  protected readonly provider = 'claude' as const;
  protected readonly command: ClaudeProviderCommandPort;
  constructor(command: ClaudeProviderCommandPort) { super(); this.command = command; }
  protected parseInventory(marketplaceJSON: unknown, pluginJSON: unknown): ProviderInventory | null { return parseClaudeInventory(marketplaceJSON, pluginJSON); }
  protected inspectArgs(): readonly [readonly string[], readonly string[]] { return [['plugin', 'marketplace', 'list', '--json'], ['plugin', 'list', '--json']]; }
  protected addMarketplaceArgs(source: string): readonly string[] { return ['plugin', 'marketplace', 'add', source, '--scope', 'user']; }
  protected removeMarketplaceArgs(): readonly string[] { return ['plugin', 'marketplace', 'remove', MARKETPLACE, '--scope', 'user']; }
  protected installPluginArgs(name: string): readonly string[] { return ['plugin', 'install', `${name}@${MARKETPLACE}`, '--scope', 'user', '--yes']; }
  protected removePluginArgs(name: string): readonly string[] { return ['plugin', 'uninstall', `${name}@${MARKETPLACE}`, '--scope', 'user', '--yes']; }
}

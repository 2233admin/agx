import { describe, expect, test } from 'bun:test';

import type { ClaudeProviderCommandPort, CodexProviderCommandPort } from '../../src/application/ports';
import { ClaudeProviderAdapter, CodexProviderAdapter } from '../../src/adapters/providers/providers';
import type { ProviderActivationTarget } from '../../src/domain/provider';

const SOURCE = 'C:/agent-plugins';
const CODEX_TARGET: ProviderActivationTarget = { provider: 'codex', marketplaceSource: SOURCE, plugins: [{ name: 'grilling', version: '1.2.3', enabled: true }] };
const CLAUDE_TARGET: ProviderActivationTarget = { provider: 'claude', marketplaceSource: SOURCE, plugins: [{ name: 'grilling', version: '1.2.3', enabled: true }] };

interface Response { readonly stdout: string; readonly exitCode: number | null }

class FixtureCommand {
  readonly calls: readonly (readonly string[])[] = [];
  constructor(private readonly responses: ReadonlyMap<string, readonly Response[]>, private readonly usable = true) {}
  async available(): Promise<boolean> { return this.usable; }
  async run(args: readonly string[]): Promise<Response> {
    (this.calls as (readonly string[])[]).push([...args]);
    const key = args.join(' ');
    const queue = this.responses.get(key);
    if (queue === undefined || queue.length === 0) throw new Error(`missing fixture: ${key}`);
    const response = queue[0];
    if (response === undefined) throw new Error(`empty fixture: ${key}`);
    (this.responses as Map<string, readonly Response[]>).set(key, queue.slice(1));
    return response;
  }
}

function json(value: unknown, exitCode: number | null = 0): Response { return { stdout: JSON.stringify(value), exitCode }; }
function raw(stdout: string, exitCode: number | null = 0): Response { return { stdout, exitCode }; }
function sequence(entries: readonly [string, Response[]][], usable = true): FixtureCommand { return new FixtureCommand(new Map(entries), usable); }

const CODEX_EMPTY = json({ marketplaces: [] });
const CODEX_PLUGINS_EMPTY = json({ installed: [] });
const CODEX_PRESENT = json({ marketplaces: [{ name: 'agent-plugins', root: SOURCE }] });
const CODEX_PLUGIN = json({ installed: [{ name: 'grilling', marketplaceName: 'agent-plugins', version: '1.2.3', installed: true, enabled: true }] });
const CLAUDE_EMPTY = json([]);
const CLAUDE_PLUGINS_EMPTY = json([]);
const CLAUDE_PRESENT = json([{ name: 'agent-plugins', source: 'directory', path: SOURCE }]);
const CLAUDE_PLUGIN = json([{ id: 'grilling@agent-plugins', version: '1.2.3', scope: 'user', enabled: true }]);

const codexInventoryKeys = ['plugin marketplace list --json', 'plugin list --json'] as const;
const claudeInventoryKeys = ['plugin marketplace list --json', 'plugin list --json'] as const;


describe('CodexProviderAdapter', () => {
  test('parses structured marketplace and installed plugin inventory', async () => {
    const command = sequence([[codexInventoryKeys[0], [CODEX_PRESENT]], [codexInventoryKeys[1], [CODEX_PLUGIN]]]);
    const adapter = new CodexProviderAdapter(command as unknown as CodexProviderCommandPort);
    await expect(adapter.inspect()).resolves.toEqual({ kind: 'observed', inventory: {
      provider: 'codex', marketplace: { present: true, sourceType: 'local', source: SOURCE },
      plugins: [{ name: 'grilling', version: '1.2.3', enabled: true }],
    } });
  });

  test('preserves same canonical source and installs only missing plugin', async () => {
    const command = sequence([
      [codexInventoryKeys[0], [CODEX_PRESENT, CODEX_PRESENT]],
      [codexInventoryKeys[1], [CODEX_PLUGINS_EMPTY, CODEX_PLUGIN]],
      ['plugin add grilling@agent-plugins --json', [json({})]],
    ]);
    const adapter = new CodexProviderAdapter(command as unknown as CodexProviderCommandPort);
    await expect(adapter.activate(CODEX_TARGET)).resolves.toMatchObject({ kind: 'activated', ownership: { marketplace: 'pre-existing', plugins: [{ name: 'grilling', version: '1.2.3', source: SOURCE }] } });
    expect(command.calls).toContainEqual(['plugin', 'add', 'grilling@agent-plugins', '--json']);
    expect(command.calls).not.toContainEqual(['plugin marketplace add', SOURCE, '--json']);
  });
  test('post-activation readback mismatch is inconclusive, never success', async () => {
    const command = sequence([
      [codexInventoryKeys[0], [CODEX_EMPTY, CODEX_PRESENT]],
      [codexInventoryKeys[1], [CODEX_PLUGINS_EMPTY, json({ installed: [{ name: 'grilling', marketplaceName: 'agent-plugins', version: '1.2.3', installed: true, enabled: false }] })]],
      ['plugin marketplace add C:/agent-plugins --json', [json({})]],
      ['plugin add grilling@agent-plugins --json', [json({})]],
    ]);
    const adapter = new CodexProviderAdapter(command as unknown as CodexProviderCommandPort);
    await expect(adapter.activate(CODEX_TARGET)).resolves.toEqual({ kind: 'inconclusive', reason: 'provider-post-activation-readback-mismatch' });
  });

  test('different marketplace source is a collision and is never rebound', async () => {
    const command = sequence([[codexInventoryKeys[0], [json({ marketplaces: [{ name: 'agent-plugins', root: 'C:/other' }] })]], [codexInventoryKeys[1], [CODEX_PLUGINS_EMPTY]]]);
    const adapter = new CodexProviderAdapter(command as unknown as CodexProviderCommandPort);
    await expect(adapter.activate(CODEX_TARGET)).resolves.toEqual({ kind: 'collision', reason: 'different-marketplace-source', actualSource: 'C:/other' });
    expect(command.calls.some((args) => args.includes('add'))).toBe(false);
  });

  test('revoke removes only configs-owned plugins and exact marketplace source', async () => {
    const command = sequence([
      [codexInventoryKeys[0], [CODEX_PRESENT]], [codexInventoryKeys[1], [CODEX_PLUGIN]],
      ['plugin remove grilling@agent-plugins --json', [json({})]],
      ['plugin marketplace remove agent-plugins --json', [json({})]],
    ]);
    const adapter = new CodexProviderAdapter(command as unknown as CodexProviderCommandPort);
    await expect(adapter.revoke(CODEX_TARGET, { marketplace: 'created-by-configs', marketplaceSource: SOURCE, plugins: [{ name: 'grilling', version: '1.2.3', source: SOURCE }] })).resolves.toMatchObject({ kind: 'revoked' });
  });
  test('plugin version drift blocks revoke without removing the changed plugin', async () => {
    const command = sequence([
      [codexInventoryKeys[0], [CODEX_PRESENT]],
      [codexInventoryKeys[1], [json({ installed: [{ name: 'grilling', marketplaceName: 'agent-plugins', version: '9.9.9', installed: true, enabled: true }] })]],
    ]);
    const adapter = new CodexProviderAdapter(command as unknown as CodexProviderCommandPort);
    await expect(adapter.revoke(CODEX_TARGET, { marketplace: 'created-by-configs', marketplaceSource: SOURCE, plugins: [{ name: 'grilling', version: '1.2.3', source: SOURCE }] })).resolves.toEqual({
      kind: 'collision', reason: 'plugin-drift', actualSource: 'C:/agent-plugins:9.9.9',
    });
    expect(command.calls.some((args) => args.includes('remove'))).toBe(false);
  });
});

describe('ClaudeProviderAdapter', () => {
  test('uses Claude JSON shapes and user-scope native commands', async () => {
    const command = sequence([[claudeInventoryKeys[0], [CLAUDE_PRESENT]], [claudeInventoryKeys[1], [CLAUDE_PLUGIN]]]);
    const adapter = new ClaudeProviderAdapter(command as unknown as ClaudeProviderCommandPort);
    await expect(adapter.inspect()).resolves.toMatchObject({ kind: 'observed', inventory: { provider: 'claude', marketplace: { source: SOURCE }, plugins: [{ name: 'grilling' }] } });

    const mutation = sequence([
      [claudeInventoryKeys[0], [CLAUDE_EMPTY, CLAUDE_PRESENT]], [claudeInventoryKeys[1], [CLAUDE_PLUGINS_EMPTY, CLAUDE_PLUGIN]],
      ['plugin marketplace add C:/agent-plugins --scope user', [json({})]],
      ['plugin install grilling@agent-plugins --scope user --yes', [json({})]],
    ]);
    const activation = new ClaudeProviderAdapter(mutation as unknown as ClaudeProviderCommandPort);
    await expect(activation.activate(CLAUDE_TARGET)).resolves.toMatchObject({ kind: 'activated', ownership: { marketplace: 'created-by-configs' } });
    expect(mutation.calls).toContainEqual(['plugin', 'marketplace', 'add', SOURCE, '--scope', 'user']);
    expect(mutation.calls).toContainEqual(['plugin', 'install', 'grilling@agent-plugins', '--scope', 'user', '--yes']);
  });

  test('missing CLI, malformed JSON, nonzero output, and timeout are inconclusive', async () => {
    const missing = new ClaudeProviderAdapter({ available: async () => false, run: async () => raw('') });
    await expect(missing.inspect()).resolves.toEqual({ kind: 'inconclusive', reason: 'provider-cli-unavailable' });

    const malformed = new CodexProviderAdapter(sequence([[codexInventoryKeys[0], [raw('{')]], [codexInventoryKeys[1], [CODEX_PLUGINS_EMPTY]]] ) as unknown as CodexProviderCommandPort);
    await expect(malformed.inspect()).resolves.toEqual({ kind: 'inconclusive', reason: 'provider-inventory-inconclusive' });

    const nonzero = new CodexProviderAdapter(sequence([[codexInventoryKeys[0], [json({}, 1)]], [codexInventoryKeys[1], [CODEX_PLUGINS_EMPTY]]] ) as unknown as CodexProviderCommandPort);
    await expect(nonzero.inspect()).resolves.toEqual({ kind: 'inconclusive', reason: 'provider-inventory-inconclusive' });

    const timeout = new CodexProviderAdapter({ available: async () => { throw new Error('timeout'); }, run: async () => raw('') });
    await expect(timeout.inspect()).resolves.toEqual({ kind: 'inconclusive', reason: 'provider-inventory-inconclusive' });
  });
  test('strictly rejects duplicate and unknown JSON fields', async () => {
    const duplicate = new CodexProviderAdapter(sequence([
      [codexInventoryKeys[0], [raw('{\"marketplaces\":[],\"marketplaces\":[]}')]],
      [codexInventoryKeys[1], [CODEX_PLUGINS_EMPTY]],
    ]) as unknown as CodexProviderCommandPort);
    await expect(duplicate.inspect()).resolves.toEqual({ kind: 'inconclusive', reason: 'provider-inventory-inconclusive' });

    const unknown = new ClaudeProviderAdapter(sequence([
      [claudeInventoryKeys[0], [raw('[{\"name\":\"agent-plugins\",\"source\":\"directory\",\"path\":\"C:/agent-plugins\",\"unexpected\":true}]')]],
      [claudeInventoryKeys[1], [CLAUDE_PLUGINS_EMPTY]],
    ]) as unknown as ClaudeProviderCommandPort);
    await expect(unknown.inspect()).resolves.toEqual({ kind: 'inconclusive', reason: 'provider-inventory-inconclusive' });
  });

  test('pre-existing marketplace is preserved and changed source cannot be revoked', async () => {
    const command = sequence([[claudeInventoryKeys[0], [CLAUDE_PRESENT]], [claudeInventoryKeys[1], [CLAUDE_PLUGIN]]]);
    const adapter = new ClaudeProviderAdapter(command as unknown as ClaudeProviderCommandPort);
    await expect(adapter.revoke(CLAUDE_TARGET, { marketplace: 'pre-existing', marketplaceSource: SOURCE, plugins: [] })).resolves.toEqual({ kind: 'preserved', reason: 'marketplace-pre-existing' });

    const changed = sequence([[claudeInventoryKeys[0], [json([{ name: 'agent-plugins', source: 'directory', path: 'C:/other' }])]], [claudeInventoryKeys[1], [CLAUDE_PLUGIN]]]);
    await expect(new ClaudeProviderAdapter(changed as unknown as ClaudeProviderCommandPort).revoke(CLAUDE_TARGET, { marketplace: 'created-by-configs', marketplaceSource: SOURCE, plugins: [] })).resolves.toEqual({ kind: 'collision', reason: 'marketplace-source-changed', actualSource: 'C:/other' });
  });
});

import { describe, expect, test } from 'bun:test';
import { parseDeploymentInput } from '../../src/domain/deployment-input';

const VALID = {
  schemaVersion: 1,
  sourceRoot: 'C:/workspace/source',
  deploymentId: 'deployment-1',
  operationId: 'operation-1',
  revisionId: 'revision-1',
  repositories: [{
    owner: 'acme', name: 'agent-control', visibility: 'private', description: 'control plane', sourcePath: 'C:/workspace/source/agent-control',
    initialRevision: { commit: 'a'.repeat(40), templateVersion: 'v1.0.0', templateDigest: 'b'.repeat(64), requiredPaths: ['README.md', 'src/index.ts'] },
  }],
  project: { owner: 'acme', title: 'Agent Control', visibility: 'private', linkedRepository: 'acme/agent-control', installationId: 'installation-1' },
  providers: [{ provider: 'codex', marketplaceSource: 'https://example.test/marketplace.json', plugins: [{ name: 'plugin-one', version: '1.0.0', enabled: true }] }],
  multicaSubjects: [{ kind: 'runtime', id: 'd3baaa7b-1111-4111-8111-111111111111' }],
};

function json(value: unknown): string { return JSON.stringify(value); }
function accepted(value: unknown) { const result = parseDeploymentInput(json(value)); expect(result.kind).toBe('accepted'); return result.kind === 'accepted' ? result.input : null; }
function rejected(value: unknown) { const result = parseDeploymentInput(json(value)); expect(result.kind).toBe('rejected'); return result.kind === 'rejected' ? result.diagnostics : []; }

describe('parseDeploymentInput', () => {
  test('accepts the versioned deployment contract and maps it to DeploymentPreflightInput', () => {
    const result = parseDeploymentInput(json(VALID));
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.sourceValidation).toBe('deferred-realpath-required');
    expect(result.input.deploymentId).toBe('deployment-1');
    expect(result.input.repositories[0]?.initialRevision.templateDigest).toBe('b'.repeat(64));
    expect(result.input.providers[0]?.plugins[0]?.name).toBe('plugin-one');
    expect(result.input.multicaSubjects?.[0]?.kind).toBe('runtime');
  });

  test('rejects unknown, duplicate, and trailing JSON fields without exposing payloads', () => {
    expect(rejected({ ...VALID, extra: 'secret-value' })[0]?.code).toBe('unknown-field');
    expect(parseDeploymentInput('{"schemaVersion":1,"schemaVersion":1}').kind).toBe('rejected');
    expect(parseDeploymentInput(`${json(VALID)} trailing`).kind).toBe('rejected');
    expect(rejected({ ...VALID, extra: 'secret-value' }).join(' ')).not.toContain('secret-value');
  });

  test('rejects oversized input and bounds diagnostics', () => {
    const diagnostics = rejected({ ...VALID, description: 'x'.repeat(1_100_000) });
    expect(diagnostics[0]?.code).toBe('input-too-large');
    expect(diagnostics.length).toBeLessThanOrEqual(32);
    expect(diagnostics.every((entry) => entry.message.length <= 160)).toBe(true);
  });

  test('rejects malformed selectors, IDs, URLs, digests, and paths', () => {
    const value = JSON.parse(json(VALID)) as Record<string, unknown>;
    value.deploymentId = '../bad';
    value.operationId = '';
    value.revisionId = 'bad id';
    const provider = (value.providers as Array<Record<string, unknown>>)[0]!;
    provider.marketplaceSource = 'not-a-url';
    const repository = (value.repositories as Array<Record<string, unknown>>)[0]!;
    const initialRevision = repository.initialRevision as Record<string, unknown>;
    initialRevision.commit = 'not-a-commit';
    initialRevision.templateDigest = 'not-a-digest';
    repository.sourcePath = 'C:/workspace/other/repo';
    initialRevision.requiredPaths = ['../escape'];
    const codes = rejected(value).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['invalid-deployment-id', 'invalid-operation-id', 'invalid-revision-id', 'invalid-marketplace-url', 'invalid-commit', 'invalid-template-digest', 'source-path-outside-root', 'invalid-required-path']));
  });
  test('rejects empty required paths, non-UUID Multica IDs, and credential-bearing marketplace URLs', () => {
    const emptyPaths = JSON.parse(json(VALID)) as Record<string, unknown>;
    const emptyRepository = (emptyPaths.repositories as Array<Record<string, unknown>>)[0]!;
    (emptyRepository.initialRevision as Record<string, unknown>).requiredPaths = [];
    expect(rejected(emptyPaths).map((entry) => entry.code)).toContain('invalid-required-path');

    const unsafeUrl = JSON.parse(json(VALID)) as Record<string, unknown>;
    (unsafeUrl.providers as Array<Record<string, unknown>>)[0]!.marketplaceSource = 'https://user:password@example.test/marketplace.json';
    expect(rejected(unsafeUrl).map((entry) => entry.code)).toContain('invalid-marketplace-url');

    const badMulticaId = JSON.parse(json(VALID)) as Record<string, unknown>;
    (badMulticaId.multicaSubjects as Array<Record<string, unknown>>)[0]!.id = 'runtime-1';
    expect(rejected(badMulticaId).map((entry) => entry.code)).toContain('invalid-multica-subject');
  });

  test('rejects duplicate repository/provider identities and null or primitive entries', () => {
    const value = JSON.parse(json(VALID)) as Record<string, unknown>;
    value.repositories = [VALID.repositories[0]!, { ...VALID.repositories[0]! }];
    value.providers = [VALID.providers[0]!, { ...VALID.providers[0]! }];
    value.multicaSubjects = [null, 'runtime-2'];
    const codes = rejected(value).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['duplicate-repository', 'duplicate-provider', 'invalid-multica-subject']));
  });

  test('rejects invalid schema version and missing required selectors', () => {
    const value = { ...VALID, schemaVersion: 2 };
    Reflect.deleteProperty(value, 'project');
    const codes = rejected(value).map((entry) => entry.code);
    expect(codes).toEqual(expect.arrayContaining(['unsupported-schema-version', 'missing-field', 'invalid-project']));
  });
});

import path from 'node:path';
import { SqliteConfigRevisionRepository } from '../sqlite/repository';
import { SqliteDeploymentOperationRepository } from '../sqlite/deployment-operation-repository';
import { SqliteOperationJournal } from '../sqlite/operation-journal';
import { SqliteLaunchPlanRepository } from '../sqlite/launch-repository';
import { createGithubProjectCommandPort, createGithubRepositoryCommandPort, createGithubRepositoryGitPort } from '../github/command-port';
import { GithubProjectAdapter } from '../github/project';
import { FsGithubRepositorySourcePort, GithubRepositoryAdapter } from '../github/repository';
import { createClaudeProviderCommandPort, createCodexProviderCommandPort } from '../providers/process';
import { ClaudeProviderAdapter, CodexProviderAdapter } from '../providers/providers';
import { createMulticaCommandPort } from '../multica/process';
import { MulticaCliAdapter } from '../multica/cli';
import type { DeploymentApplyPorts } from '../../application/deployment-apply';
import type { DeploymentPreflightPorts } from '../../application/deployment-preflight';
import { createReadonlyStatusDependencies, type ReadonlyStatusDependencies } from './readonly-status';
import type { GithubProjectCommandPort, GithubRepositoryCommandPort, GithubRepositoryGitPort, ProviderActivationPort, ProviderInventoryPort, MulticaCommandPort, CodexProviderCommandPort, ClaudeProviderCommandPort } from '../../application/ports';
import type { ProviderActivationTarget, ProviderName, ProviderOwnershipRecord, ProviderRevokeResult, ProviderInventoryResult } from '../../domain/provider';

export interface DefaultDeploymentCommands {
  readonly repository: GithubRepositoryCommandPort;
  readonly git: GithubRepositoryGitPort;
  readonly project: GithubProjectCommandPort;
  readonly codex: CodexProviderCommandPort;
  readonly claude: ClaudeProviderCommandPort;
  readonly multica: MulticaCommandPort;
}
export interface DefaultDeploymentOptions { readonly dbPath: string; readonly cwd: string; readonly sourceRoot: string; readonly commands?: Partial<DefaultDeploymentCommands>; }
export interface DefaultDeploymentDependencies {
  readonly preflight: DeploymentPreflightPorts;
  readonly apply: DeploymentApplyPorts;
  readonly readonlyStatus: ReadonlyStatusDependencies;
  readonly close: () => void;
}
function requireAbsolute(name: string, value: string): void { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`); }
class ProviderAdapterMux implements ProviderInventoryPort, ProviderActivationPort {
  constructor(private readonly codex: CodexProviderAdapter, private readonly claude: ClaudeProviderAdapter) {}
  private adapter(provider: ProviderName): CodexProviderAdapter | ClaudeProviderAdapter { return provider === 'codex' ? this.codex : this.claude; }
  inspect(provider?: ProviderName): Promise<ProviderInventoryResult> { return provider === undefined ? Promise.resolve({ kind: 'inconclusive', reason: 'provider-selection-required' }) : this.adapter(provider).inspect(); }
  activate(target: ProviderActivationTarget) { return this.adapter(target.provider).activate(target); }
  revoke(target: ProviderActivationTarget, ownership: ProviderOwnershipRecord): Promise<ProviderRevokeResult> { return this.adapter(target.provider).revoke(target, ownership); }
}

export function createDefaultDeploymentDependencies(options: DefaultDeploymentOptions): DefaultDeploymentDependencies {
  requireAbsolute('cwd', options.cwd); requireAbsolute('sourceRoot', options.sourceRoot);
  if (options.dbPath !== ':memory:') requireAbsolute('dbPath', options.dbPath);
  const commands = options.commands ?? {};
  const repositoryCommand = commands.repository ?? createGithubRepositoryCommandPort({ cwd: options.cwd });
  const gitCommand = commands.git ?? createGithubRepositoryGitPort({ cwd: options.cwd });
  const projectCommand = commands.project ?? createGithubProjectCommandPort({ cwd: options.cwd });
  const codexCommand = commands.codex ?? createCodexProviderCommandPort({ cwd: options.cwd });
  const claudeCommand = commands.claude ?? createClaudeProviderCommandPort({ cwd: options.cwd });
  const multicaCommand = commands.multica ?? createMulticaCommandPort({ cwd: options.cwd });
  let configRepository: SqliteConfigRevisionRepository | undefined;
  let deploymentRepository: SqliteDeploymentOperationRepository | undefined;
  let operationJournal: SqliteOperationJournal | undefined;
  let launchPlanRepository: SqliteLaunchPlanRepository | undefined;
  try {
    configRepository = new SqliteConfigRevisionRepository(options.dbPath);
    deploymentRepository = new SqliteDeploymentOperationRepository(options.dbPath);
    operationJournal = new SqliteOperationJournal(options.dbPath);
    const source = new FsGithubRepositorySourcePort(gitCommand, options.sourceRoot);
    const repositories = new GithubRepositoryAdapter(repositoryCommand, source);
    const project = new GithubProjectAdapter(projectCommand);
    const providers = new ProviderAdapterMux(new CodexProviderAdapter(codexCommand), new ClaudeProviderAdapter(claudeCommand));
    const multica = new MulticaCliAdapter(multicaCommand);
    const readonlyStatus = createReadonlyStatusDependencies(options.dbPath);
    return { preflight: { revision: configRepository, repositories, source, project, providers, multica }, apply: { repositories, project, provider: providers }, readonlyStatus, close: () => { launchPlanRepository?.close(); operationJournal?.close(); deploymentRepository?.close(); configRepository?.close(); } };
  } catch (error) {
    launchPlanRepository?.close(); operationJournal?.close(); deploymentRepository?.close(); configRepository?.close();
    throw error;
  }
}

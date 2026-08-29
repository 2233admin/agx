import { decideBootstrapTree, renderBootstrap, type BootstrapParams, type BootstrapRendered, type BootstrapTemplateSource, type BootstrapTreeDecision, type BootstrapTreeEntry } from '../domain/bootstrap';

export function renderBootstrapRepository(source: BootstrapTemplateSource, params: BootstrapParams): BootstrapRendered {
  return renderBootstrap(source, params);
}

export function decideBootstrapRepositoryTree(rendered: BootstrapRendered, existing: readonly BootstrapTreeEntry[]): BootstrapTreeDecision {
  return decideBootstrapTree(rendered, existing);
}

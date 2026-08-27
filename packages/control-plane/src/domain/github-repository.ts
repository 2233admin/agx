import type { ResourceBinding } from './deployment';

export type GithubRepositoryVisibility = 'private' | 'public';
export type GithubRepositoryOwnership = 'created-by-configs' | 'pre-existing' | 'unknown';

export interface GithubRepositoryInitialRevision {
  readonly commit: string;
  readonly templateVersion: string;
  readonly templateDigest: string;
  readonly requiredPaths: readonly string[];
}

export interface GithubRepositoryTarget {
  readonly owner: string;
  readonly name: string;
  readonly visibility: GithubRepositoryVisibility;
  readonly description: string;
  readonly sourcePath: string;
  readonly initialRevision: GithubRepositoryInitialRevision;
}

export interface GithubRepositoryInspection {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly visibility: GithubRepositoryVisibility;
  readonly hasIssues: boolean;
  readonly defaultBranch: string;
  readonly headCommit: string;
  readonly initialCommit: string | null;
}

export interface GithubRepositoryBinding extends ResourceBinding {
  readonly kind: 'github-repository';
  readonly resourceId: string;
  readonly ownership: GithubRepositoryOwnership;
}

export type GithubRepositoryPreflightResult =
  | { readonly kind: 'ready' }
  | { readonly kind: 'collision'; readonly repository: GithubRepositoryInspection; readonly ownership: 'pre-existing' | 'unknown' }
  | { readonly kind: 'inconclusive'; readonly reason: string; readonly remoteRetention: 'retain' };

export type GithubRepositoryProvisionResult =
  | {
      readonly kind: 'created';
      readonly repository: GithubRepositoryInspection;

      readonly ownership: 'created-by-configs';
      readonly initialRevision: GithubRepositoryInitialRevision;
      readonly binding: GithubRepositoryBinding;
    }
  | {
      readonly kind: 'collision';
      readonly repository: GithubRepositoryInspection;
      readonly ownership: 'pre-existing' | 'unknown';
    }
  | {
      readonly kind: 'inconclusive';
      readonly stage: 'preflight' | 'create' | 'visibility' | 'readback';
      readonly reason: string;
      readonly remoteRetention: 'retain';
    };
export type GithubRepositoryReadbackResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly repository: GithubRepositoryInspection }
  | { readonly kind: 'inconclusive'; readonly reason: string; readonly remoteRetention: 'retain' };

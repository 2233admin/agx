export type GithubProjectVisibility = 'private' | 'public';
export type GithubProjectOwnership = 'created-by-configs' | 'pre-existing' | 'unknown';

export interface GithubProjectTarget {
  readonly owner: string;
  readonly title: string;
  readonly visibility: GithubProjectVisibility;
  readonly linkedRepository: string;
  readonly installationId: string;
}

export interface GithubProjectIdentity {
  readonly owner: string;
  readonly number: number;
  readonly nodeId: string;
  readonly url: string;
  readonly title: string;
  readonly visibility: GithubProjectVisibility;
}

/** Identity-only binding. URL and node ID do not prove configs ownership. */
export interface GithubProjectBinding {
  readonly kind: 'github-project';
  readonly resourceId: string;
  readonly ownership: 'unknown';
  readonly remoteIdentity: string;
  readonly destructiveActions: 'denied';
}

export type GithubProjectPreflightResult =
  | { readonly kind: 'ready' }
  | { readonly kind: 'collision'; readonly identity: GithubProjectIdentity; readonly ownership: 'pre-existing' | 'unknown' }
  | { readonly kind: 'inconclusive'; readonly reason: string; readonly remoteRetention: 'retain' };

export type GithubProjectReadbackResult =
  | { readonly kind: 'present'; readonly identity: GithubProjectIdentity; readonly hasIssues: boolean; readonly linked: boolean }
  | { readonly kind: 'absent' }
  | { readonly kind: 'inconclusive'; readonly reason: string; readonly remoteRetention: 'retain' };

export type GithubProjectProvisionResult =
  | {
      readonly kind: 'created';
      readonly identity: GithubProjectIdentity;
      readonly ownership: 'created-by-configs';
      readonly linked: true;
      readonly binding: GithubProjectBinding;
    }
  | {
      readonly kind: 'collision';
      readonly identity: GithubProjectIdentity;
      readonly ownership: 'pre-existing' | 'unknown';
    }
  | {
      readonly kind: 'inconclusive';
      readonly stage: 'preflight' | 'create' | 'visibility' | 'link' | 'readback';
      readonly reason: string;
      readonly remoteRetention: 'retain';
    };

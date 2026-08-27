export type ProviderName = 'codex' | 'claude';

export interface ProviderMarketplace {
  readonly present: boolean;
  readonly sourceType: string | null;
  readonly source: string | null;
}

export interface ProviderPlugin {
  readonly name: string;
  readonly version: string;
  readonly enabled: boolean;
}

export interface ProviderInventory {
  readonly provider: ProviderName;
  readonly marketplace: ProviderMarketplace;
  readonly plugins: readonly ProviderPlugin[];
}

export interface ProviderPluginTarget {
  readonly name: string;
  readonly version: string;
  readonly enabled: boolean;
}

export interface ProviderActivationTarget {
  readonly provider: ProviderName;
  readonly marketplaceSource: string;
  readonly plugins: readonly ProviderPluginTarget[];
}

export type ProviderOwnership = 'created-by-configs' | 'pre-existing' | 'unknown';

export interface ProviderPluginBinding {
  readonly name: string;
  readonly version: string;
  readonly source: string;
}

export interface ProviderOwnershipRecord {
  readonly marketplace: ProviderOwnership;
  readonly marketplaceSource: string;
  readonly plugins: readonly ProviderPluginBinding[];

}
export type ProviderInventoryResult =
  | { readonly kind: 'observed'; readonly inventory: ProviderInventory }
  | { readonly kind: 'inconclusive'; readonly reason: string };

export type ProviderActivationResult =
  | { readonly kind: 'activated'; readonly inventory: ProviderInventory; readonly ownership: ProviderOwnershipRecord }
  | { readonly kind: 'collision'; readonly reason: 'different-marketplace-source'; readonly actualSource: string }
  | { readonly kind: 'inconclusive'; readonly reason: string };

export type ProviderRevokeResult =
  | { readonly kind: 'revoked'; readonly ownership: ProviderOwnershipRecord }
  | { readonly kind: 'preserved'; readonly reason: 'marketplace-pre-existing' | 'ownership-unknown' }
  | { readonly kind: 'collision'; readonly reason: 'marketplace-source-changed' | 'plugin-drift'; readonly actualSource: string }
  | { readonly kind: 'inconclusive'; readonly reason: string };

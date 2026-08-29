export type MulticaSubjectKind = 'workspace' | 'runtime' | 'agent';

export interface MulticaSubject {
  readonly kind: MulticaSubjectKind;
  readonly id: string;
}

export type MulticaRuntimeStatus = 'online' | 'offline';

export interface MulticaRuntime {
  readonly id: string;
  readonly name: string;
  readonly status: MulticaRuntimeStatus;
}

export type MulticaReadbackResult =
  | { readonly kind: 'observed'; readonly subject: MulticaSubject; readonly runtime: MulticaRuntime }
  | { readonly kind: 'absent'; readonly subject: MulticaSubject }
  | { readonly kind: 'ambiguous'; readonly subject: MulticaSubject; readonly matchCount: number }
  | { readonly kind: 'offline'; readonly subject: MulticaSubject; readonly status: string }
  | { readonly kind: 'inconclusive'; readonly subject: MulticaSubject; readonly reason: string };

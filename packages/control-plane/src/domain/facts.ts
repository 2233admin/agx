/**
 * `domain/` must not import Bun, SQLite, the filesystem, or the process
 * environment. Only pure types and functions live here.
 *
 * Every fact the system reports about a configuration is either:
 * - `Known<T>`: a value that was actually observed/derived, or
 * - `Unknown`: an explicit statement that the value could not be
 *   established, together with a typed reason and when that was observed.
 *
 * `null` or omitted fields must never be used to mean "unknown" -- callers
 * must always be able to tell "known" from "unknown" from the tag alone.
 */

export interface Known<T> {
  readonly kind: 'known';
  readonly value: T;
}

export interface Unknown {
  readonly kind: 'unknown';
  readonly reason: string;
  readonly observedAt: string;
}

export type Fact<T> = Known<T> | Unknown;

export function known<T>(value: T): Known<T> {
  return { kind: 'known', value };
}

export function unknown(reason: string, observedAt: string): Unknown {
  return { kind: 'unknown', reason, observedAt };
}

export function isKnown<T>(fact: Fact<T>): fact is Known<T> {
  return fact.kind === 'known';
}

export function isUnknown<T>(fact: Fact<T>): fact is Unknown {
  return fact.kind === 'unknown';
}

/**
 * Reads the value out of a `Fact`, or returns a fallback string describing
 * why it is unavailable. Never fabricates a value for the `unknown` branch.
 */
export function factToDisplay<T>(fact: Fact<T>, format: (value: T) => string): string {
  return isKnown(fact) ? format(fact.value) : `Unknown (${fact.reason})`;
}

/**
 * Mechanical equality used by comparison logic: two known values are equal
 * iff their JSON representations match. Two facts where either side is
 * `unknown` are never declared equal -- callers must treat that field as
 * `unknown` as a whole rather than guessing.
 */
export function factsEqual<T>(a: Fact<T>, b: Fact<T>): boolean {
  if (!isKnown(a) || !isKnown(b)) {
    return false;
  }
  return JSON.stringify(a.value) === JSON.stringify(b.value);
}

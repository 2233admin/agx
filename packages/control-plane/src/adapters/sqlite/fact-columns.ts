import { type Fact, isKnown, known, unknown } from '../../domain/facts';

/**
 * `[Epic 1 retro action item]` Shared `Fact<T>` <-> SQL column
 * serialization/deserialization. `repository.ts` and `launch-repository.ts`
 * each independently wrote the exact same logic (one per Story 1.1/1.2
 * build session) -- extracted here so future serialization fixes (e.g. a
 * new stringify branch) only need to happen once.
 *
 * Every `Fact<T>` is stored as four columns: `status` (`'known'` |
 * `'unknown'`), `value`, `reason`, `observedAt`. `value` is `null` unless
 * `status === 'known'`, in which case it holds the fact's value as a raw
 * string (already a string) or its `JSON.stringify`d form.
 */
export function factColumns(fact: Fact<unknown>): {
  status: 'known' | 'unknown';
  value: string | null;
  reason: string | null;
  observedAt: string | null;
} {
  if (isKnown(fact)) {
    const value = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value);
    return { status: 'known', value, reason: null, observedAt: null };
  }
  return { status: 'unknown', value: null, reason: fact.reason, observedAt: fact.observedAt };
}

/**
 * Inverse of `factColumns`: rebuilds a `Fact<T>` from the four stored
 * columns. `parseValue` turns the raw stored string back into `T` (e.g.
 * `(v) => v === 'true'` for a boolean column) and is only invoked when
 * `status === 'known'` and `value` is non-null.
 */
export function factColumnToFact<T>(
  status: string,
  value: string | null,
  reason: string | null,
  observedAt: string | null,
  parseValue: (raw: string) => T,
): Fact<T> {
  if (status === 'known' && value !== null) {
    return known(parseValue(value));
  }
  return unknown(reason ?? 'unspecified', observedAt ?? new Date(0).toISOString());
}

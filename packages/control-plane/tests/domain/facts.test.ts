import { describe, expect, test } from 'bun:test';

import { factsEqual, factToDisplay, isKnown, isUnknown, known, unknown } from '../../src/domain/facts';

describe('facts', () => {
  test('known() tags the value as known', () => {
    const fact = known(42);
    expect(fact.kind).toBe('known');
    expect(fact.value).toBe(42);
    expect(isKnown(fact)).toBe(true);
    expect(isUnknown(fact)).toBe(false);
  });

  test('unknown() carries a typed reason and observedAt, never a bare null', () => {
    const fact = unknown('not-resolved', '2026-08-22T00:00:00.000Z');
    expect(fact.kind).toBe('unknown');
    expect(fact.reason).toBe('not-resolved');
    expect(fact.observedAt).toBe('2026-08-22T00:00:00.000Z');
    expect(isKnown(fact)).toBe(false);
    expect(isUnknown(fact)).toBe(true);
  });

  test('factToDisplay formats known values and surfaces the reason for unknown ones', () => {
    expect(factToDisplay(known('resolved'), (v) => v.toUpperCase())).toBe('RESOLVED');
    expect(factToDisplay(unknown('not-resolved', 'now'), (v: string) => v)).toBe('Unknown (not-resolved)');
  });

  describe('factsEqual', () => {
    test('two known facts with the same value are equal', () => {
      expect(factsEqual(known('a'), known('a'))).toBe(true);
    });

    test('two known facts with different values are not equal', () => {
      expect(factsEqual(known('a'), known('b'))).toBe(false);
    });

    test('never guesses equal/different when either side is unknown', () => {
      expect(factsEqual(known('a'), unknown('r', 'now'))).toBe(false);
      expect(factsEqual(unknown('r', 'now'), known('a'))).toBe(false);
      expect(factsEqual(unknown('r1', 'now'), unknown('r1', 'now'))).toBe(false);
    });

    test('structural equality for object values', () => {
      expect(factsEqual(known({ a: 1, b: [1, 2] }), known({ a: 1, b: [1, 2] }))).toBe(true);
      expect(factsEqual(known({ a: 1 }), known({ a: 2 }))).toBe(false);
    });
  });
});

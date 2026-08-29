import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { dictsForTesting, resolveLang, t, type TranslationKey } from '../../src/cli/i18n';

let originalLang: string | undefined;

beforeEach(() => {
  originalLang = process.env.CONFIGS_LANG;
});

afterEach(() => {
  if (originalLang === undefined) {
    delete process.env.CONFIGS_LANG;
  } else {
    process.env.CONFIGS_LANG = originalLang;
  }
});

describe('resolveLang', () => {
  test('defaults to zh when CONFIGS_LANG is unset', () => {
    delete process.env.CONFIGS_LANG;
    expect(resolveLang()).toBe('zh');
  });

  test('CONFIGS_LANG=en switches to en', () => {
    process.env.CONFIGS_LANG = 'en';
    expect(resolveLang()).toBe('en');
  });

  test('any other value falls back to zh (only the literal "en" switches language)', () => {
    process.env.CONFIGS_LANG = 'fr';
    expect(resolveLang()).toBe('zh');
    process.env.CONFIGS_LANG = 'EN';
    expect(resolveLang()).toBe('zh');
  });

  test('does not fall back to LANG/LC_ALL -- only CONFIGS_LANG is consulted', () => {
    const originalSystemLang = process.env.LANG;
    try {
      delete process.env.CONFIGS_LANG;
      process.env.LANG = 'en_US.UTF-8';
      expect(resolveLang()).toBe('zh');
    } finally {
      if (originalSystemLang === undefined) {
        delete process.env.LANG;
      } else {
        process.env.LANG = originalSystemLang;
      }
    }
  });
});

describe('t()', () => {
  test('default (zh) field labels for the detail block', () => {
    delete process.env.CONFIGS_LANG;
    expect(t('detail.configuration')).toBe('配置：');
    expect(t('detail.revision')).toBe('修订版本：');
    expect(t('detail.status')).toBe('状态：');
    expect(t('detail.boundary')).toBe('边界：');
  });

  test('CONFIGS_LANG=en field labels match the pre-i18n English strings', () => {
    process.env.CONFIGS_LANG = 'en';
    expect(t('detail.configuration')).toBe('Configuration:');
    expect(t('detail.revision')).toBe('Revision:');
    expect(t('detail.status')).toBe('Status:');
    expect(t('detail.boundary')).toBe('Boundary:');
  });

  test('substitutes {param} placeholders', () => {
    process.env.CONFIGS_LANG = 'en';
    expect(t('failure.failed', { planId: 'plan-123' })).toBe('Launch plan plan-123 failed.');
    delete process.env.CONFIGS_LANG;
    expect(t('failure.failed', { planId: 'plan-123' })).toBe('启动计划 plan-123 失败。');
  });

  test('a param value containing another placeholder-shaped token is not recursively substituted', () => {
    process.env.CONFIGS_LANG = 'en';
    expect(t('failure.failed', { planId: '{planId}' })).toBe('Launch plan {planId} failed.');
  });

  test('a param value containing a *different* param\'s placeholder token is not re-substituted by that other param (cross-param, not just self-reference)', () => {
    process.env.CONFIGS_LANG = 'en';
    // If `configName` were substituted first and its literal `{revisionId}`
    // text then got caught by the later `revisionId` substitution, this
    // would incorrectly become "About to launch OMP with configuration
    // \"see rev-1\" (revision rev-1)." instead of leaving the operator's
    // literal config name untouched.
    expect(t('confirmation.lead', { configName: 'see {revisionId}', revisionId: 'rev-1' })).toBe(
      'About to launch OMP with configuration "see {revisionId}" (revision rev-1).',
    );
  });

  test('closed enum values (LaunchPlan.phase) are always passed through as raw params, never looked up in the dictionary', () => {
    process.env.CONFIGS_LANG = 'zh';
    // The phase word itself must appear verbatim (English identifier),
    // even though the surrounding label is translated.
    expect(t('launchStatus.phase', { phase: 'succeeded' })).toBe('阶段：succeeded');
    process.env.CONFIGS_LANG = 'en';
    expect(t('launchStatus.phase', { phase: 'succeeded' })).toBe('Phase: succeeded');
  });

  test('a key missing from the current language falls back to the *other* language dictionary, not a raw key', () => {
    // `dictsForTesting.en` still has `en.description` on TypeScript's radar
    // as a `TranslationKey`, but at the object-literal level nothing stops
    // deleting an entry at runtime -- exactly the gap `t()`'s fallback
    // chain (`DICTS[lang][key] ?? DICTS[otherLang][key] ?? key`) is meant
    // to degrade gracefully from, rather than leaking `dot.separated.key`
    // into user-facing output.
    const key: TranslationKey = 'handoffLine';
    const original = dictsForTesting.en[key];
    try {
      delete (dictsForTesting.en as Record<string, string>)[key];
      process.env.CONFIGS_LANG = 'en';
      // Falls back to the zh string (a real, readable sentence), not the
      // literal key `'handoffLine'`.
      expect(t(key)).toBe(dictsForTesting.zh[key]!);
      expect(t(key)).not.toBe(key);
    } finally {
      (dictsForTesting.en as Record<string, string>)[key] = original!;
    }
  });

  test('the fallback chain also works the other way (zh missing -> falls back to en)', () => {
    const key: TranslationKey = 'handoffLine';
    const original = dictsForTesting.zh[key];
    try {
      delete (dictsForTesting.zh as Record<string, string>)[key];
      process.env.CONFIGS_LANG = 'zh';
      expect(t(key)).toBe(dictsForTesting.en[key]!);
      expect(t(key)).not.toBe(key);
    } finally {
      (dictsForTesting.zh as Record<string, string>)[key] = original!;
    }
  });

  test('a key missing from *both* dictionaries falls back to the raw key as a last resort', () => {
    process.env.CONFIGS_LANG = 'en';
    expect(t('this-key-does-not-exist-in-either-dictionary' as TranslationKey)).toBe('this-key-does-not-exist-in-either-dictionary');
  });
});

/**
 * A missing translation should be caught here instead of silently
 * degrading to a raw dictionary key (or the cross-language fallback) at
 * runtime -- every key present in one dictionary must be present in the
 * other.
 */
describe('zh/en dictionary parity', () => {
  test('zh and en declare exactly the same set of keys', () => {
    const zhKeys = Object.keys(dictsForTesting.zh).sort();
    const enKeys = Object.keys(dictsForTesting.en).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  test('neither dictionary has an empty-string value for any key', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const value of Object.values(dictsForTesting[lang])) {
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { attention, colorForPhase, degraded, dim, failure, shouldColor, success } from '../../src/cli/colors';
import { renderLaunchStatus } from '../../src/cli/render';
import { known } from '../../src/domain/facts';
import type { LaunchPhase, LaunchStatus } from '../../src/domain/activation';

/**
 * `shouldColor()` reads `NO_COLOR`/`process.stdout.isTTY` fresh on every
 * call (never cached) -- these tests exercise both gates directly by
 * stubbing `process.stdout.isTTY` and toggling `NO_COLOR`, matching the
 * Accessibility Floor contract in EXPERIENCE.md.
 */

let originalIsTTY: boolean | undefined;
let originalNoColor: string | undefined;

beforeEach(() => {
  originalIsTTY = process.stdout.isTTY;
  originalNoColor = process.env.NO_COLOR;
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

describe('shouldColor', () => {
  test('NO_COLOR (any value) disables color even on a TTY', () => {
    setTTY(true);
    process.env.NO_COLOR = '1';
    expect(shouldColor()).toBe(false);
  });

  test('NO_COLOR set to an empty string still disables color -- presence, not value, is what matters', () => {
    setTTY(true);
    process.env.NO_COLOR = '';
    expect(shouldColor()).toBe(false);
  });

  test('non-TTY stdout disables color even without NO_COLOR', () => {
    delete process.env.NO_COLOR;
    setTTY(false);
    expect(shouldColor()).toBe(false);
  });

  test('TTY stdout with no NO_COLOR enables color', () => {
    delete process.env.NO_COLOR;
    setTTY(true);
    expect(shouldColor()).toBe(true);
  });
});

describe('semantic color wrappers', () => {
  test('every wrapper emits no ANSI escape when color is disabled, and the plain text remains fully readable', () => {
    setTTY(false);
    delete process.env.NO_COLOR;
    for (const wrap of [success, degraded, attention, failure, dim]) {
      const wrapped = wrap('hello');
      expect(wrapped).toBe('hello');
      expect(wrapped).not.toContain('\x1b[');
    }
  });

  test('every wrapper emits an ANSI escape sequence around the text when color is enabled', () => {
    setTTY(true);
    delete process.env.NO_COLOR;
    for (const wrap of [success, degraded, attention, failure, dim]) {
      const wrapped = wrap('hello');
      expect(wrapped).toContain('\x1b[');
      expect(wrapped).toContain('hello');
      expect(wrapped.endsWith('\x1b[0m')).toBe(true);
    }
  });

  test('degraded and attention use the same color role (both yellow) per DESIGN.md', () => {
    setTTY(true);
    delete process.env.NO_COLOR;
    expect(degraded('x')).toBe(attention('x'));
  });
});

describe('colorForPhase', () => {
  beforeEach(() => {
    setTTY(true);
    delete process.env.NO_COLOR;
  });

  test('succeeded maps to success (green)', () => {
    expect(colorForPhase('succeeded', 'succeeded')).toBe(success('succeeded'));
  });

  test('degraded maps to degraded (yellow)', () => {
    expect(colorForPhase('degraded', 'degraded')).toBe(degraded('degraded'));
  });

  test('failed and incomplete map to failure (red)', () => {
    expect(colorForPhase('failed', 'failed')).toBe(failure('failed'));
    expect(colorForPhase('incomplete', 'incomplete')).toBe(failure('incomplete'));
  });

  test('cancelled and requires-restart map to attention (yellow)', () => {
    expect(colorForPhase('cancelled', 'cancelled')).toBe(attention('cancelled'));
    expect(colorForPhase('requires-restart', 'requires-restart')).toBe(attention('requires-restart'));
  });

  test('in-flight phases (prepared/awaiting-confirmation/applying/observing) stay neutral -- unwrapped, no color', () => {
    for (const phase of ['prepared', 'awaiting-confirmation', 'applying', 'observing'] as const) {
      const result = colorForPhase(phase, phase);
      expect(result).toBe(phase);
      expect(result).not.toContain('\x1b[');
    }
  });
});

/**
 * `colorForPhase` above is only exercised in isolation -- these tests
 * drive it through `renderLaunchStatus`'s actual string composition
 * (`t('launchStatus.phase', { phase: colorForPhase(status.phase,
 * status.phase) })`) with color genuinely forced on (`isTTY = true`, no
 * `NO_COLOR`), which every other existing test never does (the test
 * runner's own stdout is never a TTY, so `shouldColor()` is always false
 * there).
 */
describe('renderLaunchStatus phase coloring (through the real composition path)', () => {
  let originalLang: string | undefined;

  beforeEach(() => {
    setTTY(true);
    delete process.env.NO_COLOR;
    originalLang = process.env.CONFIGS_LANG;
    process.env.CONFIGS_LANG = 'en';
  });

  afterEach(() => {
    if (originalLang === undefined) {
      delete process.env.CONFIGS_LANG;
    } else {
      process.env.CONFIGS_LANG = originalLang;
    }
  });

  function statusWith(phase: LaunchPhase): LaunchStatus {
    return {
      revisionId: 'rev-1',
      client: 'omp',
      clientVersion: known('17.4.1'),
      phase,
      applyResult: known('applied'),
      knownDifferences: [],
    };
  }

  test('a settled "succeeded" phase is wrapped exactly in place inside the "Phase: ..." line -- the "Phase: " label itself stays unwrapped', () => {
    const output = renderLaunchStatus(statusWith('succeeded'));
    expect(output).toContain(`Phase: ${success('succeeded')}`);
    // Stripped of ANSI, the line reads exactly like the uncolored version.
    // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes is the point of this assertion
    expect(output.replace(/\x1b\[[0-9]*m/g, '')).toContain('Phase: succeeded');
  });

  test('a settled "failed" phase composes with the failure (red) wrapper', () => {
    const output = renderLaunchStatus(statusWith('failed'));
    expect(output).toContain(`Phase: ${failure('failed')}`);
  });

  test('a settled "degraded" phase composes with the degraded (yellow) wrapper', () => {
    const output = renderLaunchStatus(statusWith('degraded'));
    expect(output).toContain(`Phase: ${degraded('degraded')}`);
  });

  test('an in-flight "observing" phase is composed unwrapped -- no ANSI escape anywhere in the "Phase: ..." line', () => {
    const output = renderLaunchStatus(statusWith('observing'));
    expect(output).toContain('Phase: observing');
    const phaseLine = output.split('\n').find((line) => line.startsWith('Phase:'));
    expect(phaseLine).not.toContain('\x1b[');
  });

  test('only the phase value is colored -- the rest of the block (Revision/Client/Apply result lines) carries no ANSI at all', () => {
    const output = renderLaunchStatus(statusWith('succeeded'));
    const otherLines = output.split('\n').filter((line) => !line.startsWith('Phase:'));
    for (const line of otherLines) {
      expect(line).not.toContain('\x1b[');
    }
  });
});

import { describe, expect, test } from 'bun:test';

import {
  TERMINAL_PHASES,
  computePlanHash,
  createLaunchPlan,
  deriveLaunchStatus,
  transitionLaunchPlan,
  validateConfirmationToken,
} from '../../src/domain/activation';
import type { ConfirmationToken, LaunchPhase, LaunchPlan, LaunchPlanEvent } from '../../src/domain/activation';
import { isKnown, isUnknown, known, unknown } from '../../src/domain/facts';

function samplePlan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  const base = createLaunchPlan({
    planId: 'plan-1',
    operationId: 'op-1',
    revisionId: 'rev-1',
    configName: 'general',
    client: 'omp',
    planHash: computePlanHash('rev-1', 'omp', '2026-08-22T00:00:00.000Z'),
    createdAt: '2026-08-22T00:00:00.000Z',
  });
  return { ...base, ...overrides };
}

function tokenFor(plan: LaunchPlan, overrides: Partial<ConfirmationToken> = {}): ConfirmationToken {
  return {
    planId: plan.planId,
    revisionId: plan.revisionId,
    planHash: plan.planHash,
    issuedAt: '2026-08-22T00:01:00.000Z',
    ...overrides,
  };
}

describe('createLaunchPlan', () => {
  test('starts in `prepared` with every optional fact Unknown -- never a bare null', () => {
    const plan = samplePlan();
    expect(plan.phase).toBe('prepared');
    expect(isUnknown(plan.confirmedAt)).toBe(true);
    expect(isUnknown(plan.failureReason)).toBe(true);
    expect(isUnknown(plan.observedOutcome)).toBe(true);
  });
});

describe('computePlanHash', () => {
  test('is deterministic for identical inputs', () => {
    const a = computePlanHash('rev-1', 'omp', '2026-08-22T00:00:00.000Z');
    const b = computePlanHash('rev-1', 'omp', '2026-08-22T00:00:00.000Z');
    expect(a).toBe(b);
  });

  test('differs for different revisionId/client/preparedAt', () => {
    const base = computePlanHash('rev-1', 'omp', '2026-08-22T00:00:00.000Z');
    expect(computePlanHash('rev-2', 'omp', '2026-08-22T00:00:00.000Z')).not.toBe(base);
    expect(computePlanHash('rev-1', 'omp', '2026-08-22T00:00:01.000Z')).not.toBe(base);
  });
});

describe('transitionLaunchPlan: happy path', () => {
  test('prepared -> awaiting-confirmation -> applying -> observing -> succeeded', () => {
    let plan = samplePlan();

    const preparedOk = transitionLaunchPlan(plan, { type: 'prepared-ok' });
    expect(preparedOk.ok).toBe(true);
    if (!preparedOk.ok) throw new Error('unreachable');
    plan = preparedOk.plan;
    expect(plan.phase).toBe('awaiting-confirmation');

    const token = tokenFor(plan);
    const confirmed = transitionLaunchPlan(plan, { type: 'confirmed', token });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) throw new Error('unreachable');
    plan = confirmed.plan;
    expect(plan.phase).toBe('applying');
    expect(isKnown(plan.confirmedAt) && plan.confirmedAt.value).toBe(token.issuedAt);

    const started = transitionLaunchPlan(plan, { type: 'process-started' });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    plan = started.plan;
    expect(plan.phase).toBe('observing');

    const observed = transitionLaunchPlan(plan, { type: 'observed', outcome: 'succeeded' });
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error('unreachable');
    plan = observed.plan;
    expect(plan.phase).toBe('succeeded');
    expect(isKnown(plan.observedOutcome) && plan.observedOutcome.value).toBe('succeeded');
  });

  test('transitionLaunchPlan never mutates the input plan (immutability)', () => {
    const plan = samplePlan();
    const before = { ...plan };
    const result = transitionLaunchPlan(plan, { type: 'prepared-ok' });
    expect(result.ok).toBe(true);
    expect(plan).toEqual(before);
    if (result.ok) {
      expect(result.plan).not.toBe(plan);
    }
  });
});

describe('transitionLaunchPlan: failure paths', () => {
  test('prepared -> failed via prepared-failed carries the reason', () => {
    const plan = samplePlan();
    const result = transitionLaunchPlan(plan, { type: 'prepared-failed', reason: 'config-not-found' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.plan.phase).toBe('failed');
    expect(isKnown(result.plan.failureReason) && result.plan.failureReason.value).toBe('config-not-found');
  });

  test('awaiting-confirmation -> cancelled via rejected', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const rejected = transitionLaunchPlan(prepared.plan, { type: 'rejected' });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) throw new Error('unreachable');
    expect(rejected.plan.phase).toBe('cancelled');
  });

  test('applying -> failed via apply-failed carries the reason', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const confirmed = transitionLaunchPlan(prepared.plan, { type: 'confirmed', token: tokenFor(prepared.plan) });
    if (!confirmed.ok) throw new Error('unreachable');
    const failed = transitionLaunchPlan(confirmed.plan, { type: 'apply-failed', reason: 'spawn-process: omp-binary-not-found' });
    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error('unreachable');
    expect(failed.plan.phase).toBe('failed');
    expect(isKnown(failed.plan.failureReason) && failed.plan.failureReason.value).toContain('spawn-process');
  });

  test('observing -> incomplete when signal-based exit is undecidable', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const confirmed = transitionLaunchPlan(prepared.plan, { type: 'confirmed', token: tokenFor(prepared.plan) });
    if (!confirmed.ok) throw new Error('unreachable');
    const started = transitionLaunchPlan(confirmed.plan, { type: 'process-started' });
    if (!started.ok) throw new Error('unreachable');
    const observed = transitionLaunchPlan(started.plan, { type: 'observed', outcome: 'incomplete', reason: 'signal: SIGTERM' });
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error('unreachable');
    expect(observed.plan.phase).toBe('incomplete');
  });
});

describe('transitionLaunchPlan: confirmation replay resistance', () => {
  test('confirming twice fails the second time -- the plan already left awaiting-confirmation', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const token = tokenFor(prepared.plan);
    const firstConfirm = transitionLaunchPlan(prepared.plan, { type: 'confirmed', token });
    expect(firstConfirm.ok).toBe(true);
    if (!firstConfirm.ok) throw new Error('unreachable');

    const replay = transitionLaunchPlan(firstConfirm.plan, { type: 'confirmed', token });
    expect(replay.ok).toBe(false);
  });

  test('a token whose planHash does not match the current plan is rejected', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const staleToken = tokenFor(prepared.plan, { planHash: 'ph_stale' });
    const result = transitionLaunchPlan(prepared.plan, { type: 'confirmed', token: staleToken });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('stale-confirmation-token');
    }
  });

  test('a token for a different revisionId is rejected -- confirmations never cross configurations', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const crossConfigToken = tokenFor(prepared.plan, { revisionId: 'rev-other' });
    const result = transitionLaunchPlan(prepared.plan, { type: 'confirmed', token: crossConfigToken });
    expect(result.ok).toBe(false);
  });

  test('a token for a different planId is rejected -- confirmations never cross plans', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const crossPlanToken = tokenFor(prepared.plan, { planId: 'plan-other' });
    const result = transitionLaunchPlan(prepared.plan, { type: 'confirmed', token: crossPlanToken });
    expect(result.ok).toBe(false);
  });

  test('validateConfirmationToken directly: valid only while awaiting-confirmation and fields match', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    expect(validateConfirmationToken(prepared.plan, tokenFor(prepared.plan))).toEqual({ ok: true });
    expect(validateConfirmationToken(samplePlan(), tokenFor(samplePlan()))).toEqual({
      ok: false,
      reason: 'plan-not-awaiting-confirmation',
    });
  });
});

describe('transitionLaunchPlan: switch-requested', () => {
  function toSucceeded(): LaunchPlan {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const confirmed = transitionLaunchPlan(prepared.plan, { type: 'confirmed', token: tokenFor(prepared.plan) });
    if (!confirmed.ok) throw new Error('unreachable');
    const started = transitionLaunchPlan(confirmed.plan, { type: 'process-started' });
    if (!started.ok) throw new Error('unreachable');
    const observed = transitionLaunchPlan(started.plan, { type: 'observed', outcome: 'succeeded' });
    if (!observed.ok) throw new Error('unreachable');
    return observed.plan;
  }

  test('succeeded -> requires-restart via switch-requested', () => {
    const succeeded = toSucceeded();
    const result = transitionLaunchPlan(succeeded, { type: 'switch-requested' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.plan.phase).toBe('requires-restart');
  });

  test('degraded -> requires-restart via switch-requested', () => {
    const prepared = transitionLaunchPlan(samplePlan(), { type: 'prepared-ok' });
    if (!prepared.ok) throw new Error('unreachable');
    const confirmed = transitionLaunchPlan(prepared.plan, { type: 'confirmed', token: tokenFor(prepared.plan) });
    if (!confirmed.ok) throw new Error('unreachable');
    const started = transitionLaunchPlan(confirmed.plan, { type: 'process-started' });
    if (!started.ok) throw new Error('unreachable');
    const observed = transitionLaunchPlan(started.plan, { type: 'observed', outcome: 'degraded' });
    if (!observed.ok) throw new Error('unreachable');

    const result = transitionLaunchPlan(observed.plan, { type: 'switch-requested' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.plan.phase).toBe('requires-restart');
  });

  test('requires-restart never transitions again', () => {
    const succeeded = toSucceeded();
    const switched = transitionLaunchPlan(succeeded, { type: 'switch-requested' });
    if (!switched.ok) throw new Error('unreachable');
    const again = transitionLaunchPlan(switched.plan, { type: 'switch-requested' });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.reason).toBe('invalid-transition');
    }
  });
});

describe('transitionLaunchPlan: prepared -> requires-restart via target-requires-restart', () => {
  test('prepared -> requires-restart, failureReason recorded as already-running-session-target', () => {
    const plan = samplePlan();
    const result = transitionLaunchPlan(plan, { type: 'target-requires-restart' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.plan.phase).toBe('requires-restart');
    expect(isKnown(result.plan.failureReason) && result.plan.failureReason.value).toBe('already-running-session-target');
  });

  test('requires-restart reached via target-requires-restart never transitions again', () => {
    const plan = samplePlan();
    const result = transitionLaunchPlan(plan, { type: 'target-requires-restart' });
    if (!result.ok) throw new Error('unreachable');
    const again = transitionLaunchPlan(result.plan, { type: 'target-requires-restart' });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.reason).toBe('invalid-transition');
    }
    const otherEvent = transitionLaunchPlan(result.plan, { type: 'process-started' });
    expect(otherEvent.ok).toBe(false);
  });

  for (const phase of ['awaiting-confirmation', 'applying', 'observing'] as const) {
    test(`phase "${phase}" rejects target-requires-restart (only "prepared" accepts it)`, () => {
      const plan = samplePlan({ phase });
      const result = transitionLaunchPlan(plan, { type: 'target-requires-restart' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid-transition');
      }
    });
  }
});

describe('transitionLaunchPlan: terminal phases reject every other event', () => {
  const allEvents: LaunchPlanEvent[] = [
    { type: 'prepared-ok' },
    { type: 'prepared-failed', reason: 'x' },
    { type: 'confirmed', token: { planId: 'plan-1', revisionId: 'rev-1', planHash: 'ph', issuedAt: 'now' } },
    { type: 'rejected' },
    { type: 'process-started' },
    { type: 'apply-failed', reason: 'x' },
    { type: 'observed', outcome: 'succeeded' },
    { type: 'switch-requested' },
    { type: 'target-requires-restart' },
  ];

  for (const phase of ['cancelled', 'failed', 'incomplete', 'requires-restart'] as const) {
    test(`phase "${phase}" rejects every event`, () => {
      const plan = samplePlan({ phase });
      for (const event of allEvents) {
        const result = transitionLaunchPlan(plan, event);
        expect(result.ok).toBe(false);
      }
    });
  }

  // `succeeded`/`degraded` are terminal too, but -- unlike the four phases
  // above -- they accept exactly one more event (`switch-requested`, see
  // the `case 'succeeded': case 'degraded':` block in `transitionLaunchPlan`).
  // Swept separately so that exception is asserted explicitly rather than
  // silently excluded from the "reject every event" sweep.
  for (const phase of ['succeeded', 'degraded'] as const) {
    test(`phase "${phase}" rejects every event except switch-requested`, () => {
      const plan = samplePlan({ phase });
      for (const event of allEvents) {
        const result = transitionLaunchPlan(plan, event);
        if (event.type === 'switch-requested') {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
        }
      }
    });
  }

  test('TERMINAL_PHASES lists all six terminal phases', () => {
    const expected: LaunchPhase[] = ['cancelled', 'degraded', 'failed', 'incomplete', 'requires-restart', 'succeeded'];
    expect([...TERMINAL_PHASES].sort()).toEqual(expected.sort());
  });
});

describe('deriveLaunchStatus', () => {
  test('never carries task goal/conversation/tool-call/progress/result fields', () => {
    const plan = samplePlan();
    const status = deriveLaunchStatus(plan, known('17.4.1'), []);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(/prompt|conversation|transcript|toolCall|taskProgress|taskResult/i);
    expect(status.revisionId).toBe(plan.revisionId);
    expect(status.client).toBe(plan.client);
  });

  test('applyResult is Known("applied") when observedOutcome is succeeded', () => {
    const plan = samplePlan({ phase: 'succeeded', observedOutcome: known('succeeded') });
    const status = deriveLaunchStatus(plan, known('17.4.1'), []);
    expect(isKnown(status.applyResult) && status.applyResult.value).toBe('applied');
  });

  test('applyResult is Known("degraded") when observedOutcome is degraded', () => {
    const plan = samplePlan({ phase: 'degraded', observedOutcome: known('degraded') });
    const status = deriveLaunchStatus(plan, known('17.4.1'), ['instructions-content-not-materialized-in-mvp']);
    expect(isKnown(status.applyResult) && status.applyResult.value).toBe('degraded');
  });

  test('applyResult is Unknown when the outcome is not yet observed -- never fabricated as applied', () => {
    const plan = samplePlan();
    const status = deriveLaunchStatus(plan, known('17.4.1'), []);
    expect(isUnknown(status.applyResult)).toBe(true);
  });

  test('applyResult is Unknown (not fabricated as applied/degraded) when the outcome was failed', () => {
    const plan = samplePlan({ phase: 'failed', observedOutcome: known('failed') });
    const status = deriveLaunchStatus(plan, known('17.4.1'), []);
    expect(isUnknown(status.applyResult)).toBe(true);
  });

  test('clientVersion Unknown is passed through untouched', () => {
    const plan = samplePlan();
    const version = unknown('omp-binary-not-found', 'now');
    const status = deriveLaunchStatus(plan, version, []);
    expect(status.clientVersion).toEqual(version);
  });
});

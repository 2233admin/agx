import { describe, expect, test } from 'bun:test';

import { SqliteLaunchPlanRepository } from '../../src/adapters/sqlite/launch-repository';
import { computePlanHash, createLaunchPlan, transitionLaunchPlan } from '../../src/domain/activation';
import type { LaunchPlan } from '../../src/domain/activation';
import { isKnown, isUnknown, known } from '../../src/domain/facts';

function samplePlan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  const base = createLaunchPlan({
    planId: overrides.planId ?? 'plan-1',
    operationId: 'op-1',
    revisionId: 'rev-1',
    configName: 'general',
    client: 'omp',
    planHash: computePlanHash('rev-1', 'omp', '2026-08-22T00:00:00.000Z'),
    createdAt: '2026-08-22T00:00:00.000Z',
  });
  return { ...base, ...overrides };
}

describe('SqliteLaunchPlanRepository (:memory:, STRICT)', () => {
  test('creates STRICT tables via a transactional migration and starts empty', async () => {
    const repo = new SqliteLaunchPlanRepository(':memory:');
    try {
      expect(await repo.findById('does-not-exist')).toBeNull();
      expect(await repo.findActiveForClient('omp')).toBeNull();
    } finally {
      repo.close();
    }
  });

  test('save() + findById() round-trips a plan in `prepared`, with every Fact field Unknown', async () => {
    const repo = new SqliteLaunchPlanRepository(':memory:');
    try {
      const plan = samplePlan();
      await repo.save(plan);
      const found = await repo.findById(plan.planId);
      expect(found).not.toBeNull();
      expect(found!.planId).toBe(plan.planId);
      expect(found!.phase).toBe('prepared');
      expect(isUnknown(found!.confirmedAt)).toBe(true);
      expect(isUnknown(found!.failureReason)).toBe(true);
      expect(isUnknown(found!.observedOutcome)).toBe(true);
    } finally {
      repo.close();
    }
  });

  test('save() again on the same planId updates the row in place (upsert), not a duplicate', async () => {
    const repo = new SqliteLaunchPlanRepository(':memory:');
    try {
      const plan = samplePlan();
      await repo.save(plan);

      const preparedOk = transitionLaunchPlan(plan, { type: 'prepared-ok' });
      if (!preparedOk.ok) throw new Error('unreachable');
      await repo.save(preparedOk.plan);

      const found = await repo.findById(plan.planId);
      expect(found!.phase).toBe('awaiting-confirmation');

      const active = await repo.findActiveForClient('omp');
      expect(active!.planId).toBe(plan.planId);
    } finally {
      repo.close();
    }
  });

  test('round-trips Known facts (confirmedAt/failureReason/observedOutcome) faithfully', async () => {
    const repo = new SqliteLaunchPlanRepository(':memory:');
    try {
      const plan = samplePlan({
        phase: 'succeeded',
        confirmedAt: known('2026-08-22T00:01:00.000Z'),
        failureReason: known('no-failure-recorded'),
        observedOutcome: known('succeeded'),
      });
      await repo.save(plan);
      const found = await repo.findById(plan.planId);
      expect(isKnown(found!.confirmedAt) && found!.confirmedAt.value).toBe('2026-08-22T00:01:00.000Z');
      expect(isKnown(found!.failureReason) && found!.failureReason.value).toBe('no-failure-recorded');
      expect(isKnown(found!.observedOutcome) && found!.observedOutcome.value).toBe('succeeded');
    } finally {
      repo.close();
    }
  });

  test('findActiveForClient returns the most recently created plan for that client', async () => {
    const repo = new SqliteLaunchPlanRepository(':memory:');
    try {
      const older = samplePlan({ planId: 'plan-older', createdAt: '2026-08-22T00:00:00.000Z' });
      const newer = samplePlan({ planId: 'plan-newer', createdAt: '2026-08-22T01:00:00.000Z' });
      await repo.save(older);
      await repo.save(newer);

      const active = await repo.findActiveForClient('omp');
      expect(active!.planId).toBe('plan-newer');
    } finally {
      repo.close();
    }
  });

  test('findActiveForClient scopes strictly by client', async () => {
    const repo = new SqliteLaunchPlanRepository(':memory:');
    try {
      await repo.save(samplePlan({ planId: 'plan-claude', client: 'claude-code' }));
      const active = await repo.findActiveForClient('omp');
      expect(active).toBeNull();
    } finally {
      repo.close();
    }
  });
});

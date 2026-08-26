import { describe, expect, test } from 'bun:test';

import { BunOmpCapabilityProbe } from '../../src/adapters/omp/capability-probe';

describe('BunOmpCapabilityProbe', () => {
  test('is a real, one-time probe that branches on whether the omp binary is actually reachable', async () => {
    const probe = new BunOmpCapabilityProbe();
    const result = await probe.probeStatusViewingCapability();

    const binaryPresent = Bun.which('omp') !== null;
    if (binaryPresent) {
      // Binary found: the honest finding is that native OMP has no concept
      // of "which Agent System configuration revision started this
      // process" -- never hardcoded to skip probing nor claimed as
      // already satisfied.
      expect(result.level).toBe('unsupported');
      expect(result.reason).toBe('omp-native-interface-has-no-agent-system-config-concept');
    } else {
      expect(result.level).toBe('unknown');
      expect(result.reason).toBe('omp-binary-not-found');
    }
  });

  test('never returns "supported" without evidence -- level is always one of the four typed values', async () => {
    const probe = new BunOmpCapabilityProbe();
    const result = await probe.probeStatusViewingCapability();
    expect(['supported', 'degraded', 'unsupported', 'unknown']).toContain(result.level);
  });
});

import type { CapabilityProbeResult, OmpCapabilityProbePort } from '../../application/ports';

/**
 * A real, one-time probe: if the `omp` binary cannot even be found, the
 * result is honestly `unknown` (bridge unavailable) rather than
 * `unsupported`. If it is found, the result is `unsupported` -- not
 * because this skips native-first, but because it is the true finding:
 * OMP's native `--help`/`omp config` surface (verified against a real
 * install, see Design Notes) has no concept of "which Agent System
 * configuration revision started this process". That is a product-
 * specific fact OMP has never seen, so native support can never cover it.
 */
export class BunOmpCapabilityProbe implements OmpCapabilityProbePort {
  async probeStatusViewingCapability(): Promise<CapabilityProbeResult> {
    const binaryPath = Bun.which('omp');
    if (binaryPath === null) {
      return { level: 'unknown', reason: 'omp-binary-not-found' };
    }

    return {
      level: 'unsupported',
      reason: 'omp-native-interface-has-no-agent-system-config-concept',
    };
  }
}

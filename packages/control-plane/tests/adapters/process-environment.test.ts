import { describe, expect, test } from 'bun:test';
import { buildChildEnvironment } from '../../src/adapters/system/process-environment';

describe('child process environment', () => {
  test('keeps PATH and requested runtime keys but excludes inherited secrets', () => {
    const environment = buildChildEnvironment({
      PATH: '/runtime/path',
      AGENT_SYSTEM_LAUNCH_CONTEXT: '/tmp/context.json',
      SECRET_TOKEN: 'must-not-pass',
    });

    expect(environment).toEqual({ PATH: '/runtime/path', AGENT_SYSTEM_LAUNCH_CONTEXT: '/tmp/context.json' });
  });
});

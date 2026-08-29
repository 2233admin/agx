const RUNTIME_KEYS = ['PATH', 'AGENT_SYSTEM_LAUNCH_CONTEXT', 'CLAUDE_CONFIG_DIR'] as const;

export function buildChildEnvironment(overrides: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of RUNTIME_KEYS) {
    const value = overrides[key] ?? process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

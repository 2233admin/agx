export const PUBLIC_STATUS_FIELDS = [
  'deploymentId',
  'operationId',
  'phase',
  'revisionId',
  'resourceCount',
  'ownership',
  'nextAction',
  'observedAt',
] as const;

type PublicStatusField = (typeof PUBLIC_STATUS_FIELDS)[number];
type PublicScalar = string | number | boolean | null;

export type PublicStatus = Partial<Record<PublicStatusField, PublicScalar>>;

export function redactStatus(input: Readonly<Record<string, unknown>>): PublicStatus {
  const output: PublicStatus = {};
  for (const field of PUBLIC_STATUS_FIELDS) {
    const value = input[field];
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[field] = value;
    }
  }
  return output;
}

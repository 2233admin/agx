import { summarizeFirstUseEvidence, validateFirstUseContract, type FirstUseContractDecision, type FirstUseEvidenceDecision } from '../domain/first-use';

export function validateFirstUse(input: unknown): FirstUseContractDecision {
  return validateFirstUseContract(input);
}

export function summarizeFirstUse(input: unknown): FirstUseEvidenceDecision {
  return summarizeFirstUseEvidence(input);
}

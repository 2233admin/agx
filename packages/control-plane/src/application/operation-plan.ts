import type { OperationJournalPort } from './ports';
import { createOperationJournal, type OperationPlanInput, type OperationJournalRecord } from '../domain/operation-journal';

/** Creates and records a deterministic local plan; it never contacts a remote adapter. */
export async function prepareDeploymentOperationPlan(
  journal: OperationJournalPort,
  input: OperationPlanInput,
): Promise<OperationJournalRecord> {
  createOperationJournal(input);
  return journal.prepare(input);
}

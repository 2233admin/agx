import type { OperationJournalPort } from '../../application/ports';
import { appendOperationStep, createOperationJournal, finishOperationJournal, resolveInconclusiveOperation, startOperationJournal, type OperationJournalRecord, type OperationPlanInput, type OperationResolution, type OperationStep } from '../../domain/operation-journal';

export class InMemoryOperationJournal implements OperationJournalPort {
  readonly remoteCalls = 0;
  private readonly records = new Map<string, OperationJournalRecord>();

  async prepare(input: OperationPlanInput): Promise<OperationJournalRecord> {
    if (this.records.has(input.operationId)) throw new Error('operation already prepared');
    const record = createOperationJournal(input);
    this.records.set(record.operationId, record);
    return record;
  }


  async start(operationId: string): Promise<OperationJournalRecord> {
    const current = this.records.get(operationId);
    if (current === undefined) throw new Error('operation not found');
    const updated = startOperationJournal(current);
    this.records.set(operationId, updated);
    return updated;
  }
  async resolveInconclusive(operationId: string, resolution: OperationResolution, now: string): Promise<OperationJournalRecord> {
    const current = this.records.get(operationId);
    if (current === undefined) throw new Error('operation not found');
    const updated = resolveInconclusiveOperation(current, resolution, now);
    this.records.set(operationId, updated);
    return updated;
  }

  async finish(operationId: string, phase: 'succeeded' | 'failed' | 'cancelled', reason?: string): Promise<OperationJournalRecord> {
    const current = this.records.get(operationId);
    if (current === undefined) throw new Error('operation not found');
    const updated = finishOperationJournal(current, phase, reason);
    this.records.set(operationId, updated);
    return updated;
  }
  async appendStep(operationId: string, step: OperationStep): Promise<OperationJournalRecord> {
    const current = this.records.get(operationId);
    if (current === undefined) throw new Error('operation not found');
    const updated = appendOperationStep(current, step);
    this.records.set(operationId, updated);
    return updated;
  }

  async find(operationId: string): Promise<OperationJournalRecord | null> {
    return this.records.get(operationId) ?? null;
  }
}

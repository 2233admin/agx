import { projectStatus, type StatusProjectionInput, type UnifiedStatus } from '../domain/status';

export interface DiagnoseResult extends UnifiedStatus {
  readonly readOnly: true;
}

export function diagnoseDeployment(input: StatusProjectionInput): DiagnoseResult {
  return { ...projectStatus(input), readOnly: true };
}

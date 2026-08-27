import { projectStatus, type StatusProjectionInput, type UnifiedStatus } from '../domain/status';

export function getUnifiedStatus(input: StatusProjectionInput): UnifiedStatus {
  return projectStatus(input);
}

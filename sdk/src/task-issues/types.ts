export interface ExportPhaseIssuesInput {
  phase: string;
  dryRun?: boolean;
  repo?: string;
}

export type ExportPhaseIssuesResult = Record<string, unknown>;

export interface WorkTaskIssueInput {
  selector?: string;
  phase?: string;
  repo?: string;
  readOnly?: boolean;
  execute?: boolean;
  reconcile?: boolean;
  completePhase?: string;
}

export type WorkTaskIssueResult = Record<string, unknown>;

export interface OrchestrateTasksInput {
  issueNumbers?: Array<number | string>;
  repo?: string;
  dryRun?: boolean;
  maxConcurrency?: number;
  allowPartial?: boolean;
  resume?: string;
  confirmPartial?: boolean;
  confirmReviewability?: boolean;
  executorBackend?: 'agent' | 'command';
  executorCommand?: string;
}

export type OrchestrateTasksResult = Record<string, unknown>;

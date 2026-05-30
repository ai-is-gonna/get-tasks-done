export interface TaskIssueLabel {
  name: string;
  color?: string;
  description?: string;
}

export interface TaskIssueRecord {
  id?: number | string;
  number: number;
  title?: string;
  body?: string;
  state?: string;
  labels?: Array<string | TaskIssueLabel>;
  [key: string]: unknown;
}

export interface TaskIssuePullRequest {
  number: number;
  url?: string;
  state?: string;
  merged?: boolean;
  headRefName?: string;
  baseRefName?: string;
  [key: string]: unknown;
}

export interface TaskIssueGitHubAdapter {
  getLabel?(name: string): TaskIssueLabel | null;
  ensureLabel?(name: string, options?: Record<string, unknown>): unknown;
  getIssue(number: number | string): TaskIssueRecord | null;
  searchIssuesContaining?(identity: string): TaskIssueRecord[];
  createIssue?(input: { title: string; body: string; labels?: string[] }): TaskIssueRecord;
  updateIssue?(number: number | string, input: { title?: string; body?: string; labels?: string[] }): TaskIssueRecord;
  addLabels?(number: number | string, labels: string[]): TaskIssueRecord;
  removeLabels?(number: number | string, labels: string[]): TaskIssueRecord;
  commentIssue?(number: number | string, body: string): unknown;
  listSubIssues?(parentNumber: number | string): TaskIssueRecord[];
  addSubIssue?(parentNumber: number | string, childIssueId: number | string): unknown;
  listBlockedBy?(issueNumber: number | string): TaskIssueRecord[];
  addBlockedBy?(issueNumber: number | string, blockingIssueId: number | string): unknown;
  viewPullRequest?(number: number | string): TaskIssuePullRequest | null;
  createPullRequest?(input: Record<string, unknown>): TaskIssuePullRequest;
  updatePullRequest?(number: number | string, input: Record<string, unknown>): TaskIssuePullRequest;
  reopenPullRequest?(number: number | string): TaskIssuePullRequest;
  mergePullRequest?(number: number | string, input?: Record<string, unknown>): TaskIssuePullRequest;
}

export interface TaskIssueGitAdapter {
  run(args: string[], options?: { cwd?: string; input?: string | null; timeoutMs?: number }): {
    ok: boolean;
    status?: number | null;
    stdout: string;
    stderr: string;
    error?: Error | null;
  };
}

export interface TaskIssueFileSystemAdapter {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, content: string): void;
  mkdir(path: string): void;
  readDir(path: string): string[];
  remove?(path: string): void;
}

export interface TaskIssueSubprocessAdapter {
  run(command: string, args: string[], options?: { cwd?: string; input?: string | null; timeoutMs?: number }): {
    status?: number | null;
    stdout: string;
    stderr: string;
    error?: Error | null;
  };
}

export interface TaskIssueClockAdapter {
  now(): Date;
}

export interface TaskIssueIdGenerator {
  id(prefix?: string): string;
}

export interface TaskIssueExecutorAdapter {
  run(input: Record<string, unknown>): Record<string, unknown>;
}

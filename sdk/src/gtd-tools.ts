/**
 * GTD Tools Bridge — programmatic access to GTD planning operations.
 *
 * By default routes commands through the SDK **query registry** (same handlers as
 * `gtd-sdk query`) so `PhaseRunner`, `InitRunner`, and `GTD` share contracts with
 * the typed CLI. Runner hot-path helpers (`initPhaseOp`, `phasePlanIndex`,
 * `phaseComplete`, `initNewProject`, `configSet`, `commit`) call
 * `registry.dispatch()` with canonical keys when native query is active, avoiding
 * repeated argv resolution. When a workstream is set, dispatches to `gtd-tools.cjs` so
 * workstream env stays aligned with CJS.
 */


import type { InitNewProjectInfo, PhaseOpInfo, PhasePlanIndex, RoadmapAnalysis } from './types.js';
import type {
  ExportPhaseIssuesInput,
  ExportPhaseIssuesResult,
  OrchestrateTasksInput,
  OrchestrateTasksResult,
  WorkTaskIssueInput,
  WorkTaskIssueResult,
} from './task-issues/types.js';
import type { GTDEventStream } from './event-stream.js';
import { toToolsErrorFromUnknown } from './query-tools-error-factory.js';
import { GTDToolsError } from './gtd-tools-error.js';
import type { QueryCommandResolution } from './query/query-command-resolution-strategy.js';
import { resolveGtdToolsPath } from './query-gtd-tools-path.js';
import { createGTDToolsRuntime } from './query-gtd-tools-runtime.js';
import { QueryCommandExecutor } from './query-command-executor.js';
import { QueryHotpathMethods } from './query-hotpath-methods.js';
import { QueryRuntimeBridge, type RuntimeBridgeOptions } from './query-runtime-bridge.js';

export { GTDToolsError } from './gtd-tools-error.js';

// ─── GTDTools class ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;


export class GTDTools {
  private readonly projectDir: string;
  private readonly gtdToolsPath: string;
  private readonly timeoutMs: number;
  private readonly workstream?: string;
  private readonly bridge: QueryRuntimeBridge;
  private readonly preferNativeQuery: boolean;
  private readonly commandExecutor: QueryCommandExecutor;
  private readonly hotpathMethods: QueryHotpathMethods;

  constructor(opts: {
    projectDir: string;
    gtdToolsPath?: string;
    timeoutMs?: number;
    workstream?: string;
    /** When set, mutation handlers emit the same events as `gtd-sdk query`. */
    eventStream?: GTDEventStream;
    /** Correlation id for mutation events when `eventStream` is set. */
    sessionId?: string;
    /**
     * When true (default), route known commands through the SDK query registry.
     * Set false in tests that substitute a mock `gtdToolsPath` script.
     */
    preferNativeQuery?: boolean;
    /** When true, fail if a command has no native registry adapter. */
    strictSdk?: boolean;
    /** Explicit subprocess bridge policy. Default false for SDK-native mode. */
    allowFallbackToSubprocess?: boolean;
    /** Structured runtime bridge dispatch observability callback. */
    onDispatchEvent?: RuntimeBridgeOptions['onDispatchEvent'];
  }) {
    this.projectDir = opts.projectDir;
    this.gtdToolsPath =
      opts.gtdToolsPath ?? resolveGtdToolsPath(opts.projectDir);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workstream = opts.workstream;
    this.preferNativeQuery = opts.preferNativeQuery ?? true;

    const runtime = createGTDToolsRuntime({
      projectDir: this.projectDir,
      gtdToolsPath: this.gtdToolsPath,
      timeoutMs: this.timeoutMs,
      workstream: this.workstream,
      eventStream: opts.eventStream,
      sessionId: opts.sessionId,
      shouldUseNativeQuery: () => this.shouldUseNativeQuery(),
      execJsonFallback: (legacyCommand, legacyArgs) => this.exec(legacyCommand, legacyArgs),
      execRawFallback: (legacyCommand, legacyArgs) => this.execRaw(legacyCommand, legacyArgs),
      strictSdk: opts.strictSdk,
      allowFallbackToSubprocess: opts.allowFallbackToSubprocess,
      onDispatchEvent: opts.onDispatchEvent,
    });

    this.bridge = runtime.bridge;
    this.commandExecutor = new QueryCommandExecutor({
      nativeMatch: (command, args) => this.nativeMatch(command, args),
      execute: async (input) => this.bridge.execute({
        legacyCommand: input.legacyCommand,
        legacyArgs: input.legacyArgs,
        registryCommand: input.registryCommand,
        registryArgs: input.registryArgs,
        mode: input.mode,
        projectDir: this.projectDir,
        workstream: this.workstream,
      }),
    });

    this.hotpathMethods = new QueryHotpathMethods({
      dispatchNativeHotpath: (legacyCommand, legacyArgs, registryCommand, registryArgs, mode) =>
        this.dispatchNativeHotpath(legacyCommand, legacyArgs, registryCommand, registryArgs, mode),
    });
  }

  private shouldUseNativeQuery(): boolean {
    return this.preferNativeQuery && !this.workstream;
  }

  private nativeMatch(command: string, args: string[]): QueryCommandResolution | null {
    return this.bridge.resolve(command, args);
  }

  private async dispatchNativeHotpath(
    legacyCommand: string,
    legacyArgs: string[],
    registryCommand: string,
    registryArgs: string[],
    mode: 'json' | 'raw',
  ): Promise<unknown> {
    return this.executeWithToolsError(legacyCommand, legacyArgs, () =>
      this.bridge.dispatchHotpath(
        legacyCommand,
        legacyArgs,
        registryCommand,
        registryArgs,
        mode,
      ));
  }

  private async executeWithToolsError<T>(command: string, args: string[], work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof GTDToolsError) throw err;
      throw toToolsErrorFromUnknown(command, args, err);
    }
  }

  // ─── Core exec ───────────────────────────────────────────────────────────

  /**
   * Execute a gtd-tools command and return parsed JSON output.
   * Handles the `@file:` prefix pattern for large results.
   */
  async exec(command: string, args: string[] = []): Promise<unknown> {
    return this.executeWithToolsError(command, args, () => this.commandExecutor.exec(command, args, 'json'));
  }

  // ─── Raw exec (no JSON parsing) ───────────────────────────────────────

  /**
   * Execute a gtd-tools command and return raw stdout without JSON parsing.
   * Use for commands like `config-set` that return plain text, not JSON.
   */
  async execRaw(command: string, args: string[] = []): Promise<string> {
    return this.executeWithToolsError(command, args, async () => {
      const out = await this.commandExecutor.exec(command, args, 'raw');
      return typeof out === 'string' ? out : String(out ?? '');
    });
  }


  // ─── Typed convenience methods ─────────────────────────────────────────

  async stateLoad(): Promise<unknown> {
    return this.exec('state', ['load']);
  }

  async roadmapAnalyze(): Promise<RoadmapAnalysis> {
    return this.exec('roadmap', ['analyze']) as Promise<RoadmapAnalysis>;
  }

  async phaseComplete(phase: string): Promise<string> {
    return this.hotpathMethods.phaseComplete(phase);
  }

  async commit(message: string, files?: string[]): Promise<string> {
    return this.hotpathMethods.commit(message, files);
  }

  async verifySummary(path: string): Promise<string> {
    return this.execRaw('verify-summary', [path]);
  }

  async initExecutePhase(phase: string): Promise<string> {
    return this.execRaw('state', ['begin-phase', '--phase', phase]);
  }

  /**
   * Query phase state from gtd-tools.cjs `init phase-op`.
   * Returns a typed PhaseOpInfo describing what exists on disk for this phase.
   */
  async initPhaseOp(phaseNumber: string): Promise<PhaseOpInfo> {
    return this.hotpathMethods.initPhaseOp(phaseNumber);
  }

  /**
   * Get a config value via the `config-get` surface (CJS and registry use the same key path).
   */
  async configGet(key: string): Promise<string | null> {
    return this.hotpathMethods.configGet(key);
  }

  /**
   * Begin phase state tracking in gtd-tools.cjs.
   */
  async stateBeginPhase(phaseNumber: string): Promise<string> {
    return this.execRaw('state', ['begin-phase', '--phase', phaseNumber]);
  }

  /**
   * Get the plan index for a phase, grouping plans into dependency waves.
   * Returns typed PhasePlanIndex with wave assignments and completion status.
   */
  async phasePlanIndex(phaseNumber: string): Promise<PhasePlanIndex> {
    return this.hotpathMethods.phasePlanIndex(phaseNumber);
  }

  /**
   * Query new-project init state from gtd-tools.cjs `init new-project`.
   * Returns project metadata, model configs, brownfield detection, etc.
   */
  async initNewProject(): Promise<InitNewProjectInfo> {
    return this.hotpathMethods.initNewProject();
  }

  /**
   * Set a config value via gtd-tools.cjs `config-set`.
   * Handles type coercion (booleans, numbers, JSON) on the gtd-tools side.
   * Note: config-set returns `key=value` text, not JSON, so we use execRaw.
   */
  async configSet(key: string, value: string): Promise<string> {
    return this.hotpathMethods.configSet(key, value);
  }

  async exportPhaseIssues(input: ExportPhaseIssuesInput): Promise<ExportPhaseIssuesResult> {
    const args = [input.phase];
    if (input.dryRun) args.push('--dry-run');
    if (input.repo) args.push('--repo', input.repo);
    return this.dispatchTaskIssueCommand('export-phase-issues', args) as Promise<ExportPhaseIssuesResult>;
  }

  async workTaskIssue(input: WorkTaskIssueInput): Promise<WorkTaskIssueResult> {
    const args: string[] = [];
    if (input.selector) args.push(input.selector);
    if (input.phase) args.push('--phase', input.phase);
    if (input.repo) args.push('--repo', input.repo);
    if (input.readOnly) args.push('--read-only');
    if (input.execute) args.push('--execute');
    if (input.reconcile) args.push('--reconcile');
    if (input.completePhase) args.push('--complete-phase', input.completePhase);
    return this.dispatchTaskIssueCommand('work-task-issue', args) as Promise<WorkTaskIssueResult>;
  }

  async orchestrateTasks(input: OrchestrateTasksInput): Promise<OrchestrateTasksResult> {
    const args = (input.issueNumbers ?? []).map((issue) => String(issue));
    if (input.repo) args.push('--repo', input.repo);
    if (input.dryRun) args.push('--dry-run');
    if (input.maxConcurrency !== undefined) args.push('--max-concurrency', String(input.maxConcurrency));
    if (input.allowPartial) args.push('--allow-partial');
    if (input.resume) args.push('--resume', input.resume);
    if (input.confirmPartial) args.push('--confirm-partial');
    if (input.confirmReviewability) args.push('--confirm-reviewability');
    if (input.executorBackend) args.push('--executor-backend', input.executorBackend);
    if (input.executorCommand) args.push('--executor-command', input.executorCommand);
    return this.dispatchTaskIssueCommand('orchestrate-tasks', args) as Promise<OrchestrateTasksResult>;
  }

  private async dispatchTaskIssueCommand(command: string, args: string[]): Promise<unknown> {
    return this.executeWithToolsError(command, args, async () => {
      const result = await this.bridge.getRegistry().dispatch(command, args, this.projectDir, this.workstream);
      return result.data;
    });
  }
}

export { resolveGtdToolsPath } from './query-gtd-tools-path.js';

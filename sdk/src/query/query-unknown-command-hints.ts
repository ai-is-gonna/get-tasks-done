export const UNKNOWN_COMMAND_HINTS: readonly string[] = [
  'Use a registered `gtd-sdk query` subcommand (see sdk/src/query/QUERY-HANDLERS.md).',
  'Invoke `node …/gtd-tools.cjs` for CJS-only operations.',
  'Unset GTD_QUERY_FALLBACK or set it to a non-restricted value to enable fallback.',
] as const;

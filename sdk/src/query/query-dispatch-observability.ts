export function fallbackBridgeNotices(command: string): string[] {
  return [
    `[gtd-sdk] '${command}' not in native registry; falling back to gtd-tools.cjs.`,
    '[gtd-sdk] Transparent bridge — prefer adding a native handler when parity matters.',
  ];
}

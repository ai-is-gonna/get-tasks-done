export function parseWorktreePorcelain(porcelain: string): Array<{ path: string; branch: string }> {
  const entries: Array<{ path: string; branch: string | null }> = [];
  const blocks = String(porcelain || '').split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    if (!worktreeLine) continue;
    const worktreePath = worktreeLine.slice('worktree '.length).trim();
    if (!worktreePath) continue;
    const branchLine = lines.find((line) => line.startsWith('branch refs/heads/'));
    const branch = branchLine ? branchLine.slice('branch refs/heads/'.length).trim() : null;
    entries.push({ path: worktreePath, branch });
  }
  return entries.filter((entry): entry is { path: string; branch: string } => Boolean(entry.branch));
}

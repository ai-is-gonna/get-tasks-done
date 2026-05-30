import { describe, it, expect } from 'vitest';
import { parseTasks } from './plan-parser.js';
import { validateTaskAtomicity } from './plan-atomicity.js';

function wrapTasks(taskXml: string): string {
  return `<tasks>${taskXml}</tasks>`;
}

function validate(taskXml: string) {
  return validateTaskAtomicity(parseTasks(wrapTasks(taskXml)));
}

function codes(result: ReturnType<typeof validateTaskAtomicity>, kind: 'blockers' | 'warnings') {
  return result[kind].map((issue) => issue.code);
}

describe('task atomicity validator', () => {
  it('blocks executable tasks with 6 or more files', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Implement authentication system</name>
  <files>src/api/auth/login.ts, src/api/auth/register.ts, src/middleware/auth.ts,
         src/utils/jwt.ts, src/db/models/user.ts, src/types/auth.ts,
         src/validators/auth.ts</files>
  <boundaries>DO NOT modify: src/config/*</boundaries>
  <action>Create login and register endpoints with JWT.</action>
  <verify>npm test</verify>
  <done>Authentication endpoints return JWT responses for valid credentials</done>
</task>
`);

    expect(result.ok).toBe(false);
    expect(codes(result, 'blockers')).toContain('too_many_files');
    expect(result.tasks[0]).toMatchObject({ executable: true, file_count: 7 });
  });

  it('passes executable tasks with 1-3 files and complete contract fields', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Create login endpoint</name>
  <files>src/api/auth/login.ts, src/types/auth.ts, src/utils/jwt.ts</files>
  <boundaries>DO NOT modify: src/middleware/*, src/db/schema.ts</boundaries>
  <action>Create POST /login endpoint that validates credentials and returns JWT.</action>
  <verify>curl -X POST /api/auth/login returns 200 with valid credentials</verify>
  <done>Login endpoint returns JWT for valid credentials</done>
</task>
`);

    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('warns on executable tasks with 4-5 files', () => {
    const result = validate(`
<task type="tdd">
  <name>Task 1: Add profile card</name>
  <files>src/profile/card.tsx, src/profile/card.test.tsx, src/profile/styles.css, src/profile/types.ts</files>
  <boundaries>DO NOT modify: src/auth/*</boundaries>
  <action>Add the profile card component.</action>
  <verify>npm test -- src/profile/card.test.tsx</verify>
  <done>Profile card renders the supplied user name and avatar</done>
</task>
`);

    expect(result.ok).toBe(true);
    expect(codes(result, 'warnings')).toContain('borderline_file_count');
  });

  it('blocks executable tasks without non-empty boundaries', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Create user model</name>
  <files>src/models/user.ts</files>
  <action>Define User type with id, email, name.</action>
  <verify>tsc --noEmit</verify>
  <done>User type exports id, email, and name fields</done>
</task>
`);

    expect(result.ok).toBe(false);
    expect(codes(result, 'blockers')).toContain('missing_boundaries');
  });

  it('blocks placeholder boundaries', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Create user model</name>
  <files>src/models/user.ts</files>
  <boundaries>No boundaries - this task creates new files only</boundaries>
  <action>Define User type with id, email, name.</action>
  <verify>tsc --noEmit</verify>
  <done>User type exports id, email, and name fields</done>
</task>
`);

    expect(result.ok).toBe(false);
    expect(codes(result, 'blockers')).toContain('placeholder_boundaries');
  });

  it('warns on boundaries without a structured limiting clause', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Create user model</name>
  <files>src/models/user.ts</files>
  <boundaries>Only touch src/models/user.ts.</boundaries>
  <action>Define User type with id, email, name.</action>
  <verify>tsc --noEmit</verify>
  <done>User type exports id, email, and name fields</done>
</task>
`);

    expect(result.ok).toBe(true);
    expect(codes(result, 'warnings')).toContain('unstructured_boundaries');
  });

  it('blocks executable tasks with empty files', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: No declared files</name>
  <files></files>
  <boundaries>DO NOT modify: src/api/*</boundaries>
  <action>Update the local type.</action>
  <verify>tsc --noEmit</verify>
  <done>Local type compiles with the new property</done>
</task>
`);

    expect(result.ok).toBe(false);
    expect(codes(result, 'blockers')).toContain('empty_files');
  });

  it('blocks verify commands that reference files produced by later executable tasks', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Create API routes</name>
  <files>src/api/routes.ts</files>
  <boundaries>DO NOT modify: src/db/*</boundaries>
  <action>Create API routes for user management.</action>
  <verify>node src/test-runner.ts</verify>
  <done>Routes return user management responses</done>
</task>
<task type="auto">
  <name>Task 2: Create test runner</name>
  <files>src/test-runner.ts</files>
  <boundaries>DO NOT modify: src/api/*</boundaries>
  <action>Create test runner script for API routes.</action>
  <verify>node src/test-runner.ts</verify>
  <done>Test runner exits zero for API route checks</done>
</task>
`);

    expect(result.ok).toBe(false);
    expect(codes(result, 'blockers')).toContain('verify_references_later_task_file');
  });

  it('blocks executable tasks missing done criteria', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Create login endpoint</name>
  <files>src/api/auth/login.ts</files>
  <boundaries>DO NOT modify: src/middleware/*</boundaries>
  <action>Create POST /login endpoint.</action>
  <verify>curl -X POST /api/auth/login returns 200</verify>
</task>
`);

    expect(result.ok).toBe(false);
    expect(codes(result, 'blockers')).toContain('missing_done');
  });

  it('warns on vague done criteria', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Auth system</name>
  <files>src/api/auth.ts</files>
  <boundaries>DO NOT modify: src/db/*</boundaries>
  <action>Create auth endpoints.</action>
  <verify>npm test -- auth</verify>
  <done>Auth working</done>
</task>
`);

    expect(result.ok).toBe(true);
    expect(codes(result, 'warnings')).toContain('vague_done');
  });

  it('warns on simple multi-concern action heuristics', () => {
    const result = validate(`
<task type="auto">
  <name>Task 1: Auth and validation</name>
  <files>src/api/auth.ts, src/validators/input.ts</files>
  <boundaries>DO NOT modify: src/db/*</boundaries>
  <action>Create authentication endpoints with JWT session handling AND also implement input validation middleware for API routes.</action>
  <verify>npm test -- auth</verify>
  <done>Auth endpoint returns JWT after validating request input</done>
</task>
`);

    expect(result.ok).toBe(true);
    expect(codes(result, 'warnings')).toContain('possible_multi_concern_action');
  });

  it('does not penalize checkpoint tasks for missing executable fields', () => {
    const result = validate(`
<task type="checkpoint:human-verify">
  <name>Task 1: Confirm rollout owner</name>
  <action>Ask the operator to confirm the rollout owner.</action>
</task>
`);

    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.tasks[0]).toMatchObject({
      executable: false,
      checkpoint: true,
      file_count: 0,
    });
  });
});

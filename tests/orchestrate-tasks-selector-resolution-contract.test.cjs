// allow-test-rule: source-text-is-the-product
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMAND_PATH = path.join(ROOT, 'commands', 'gtd', 'orchestrate-tasks.md');
const WORKFLOW_PATH = path.join(ROOT, 'get-tasks-done', 'workflows', 'orchestrate-tasks.md');
const COMMANDS_DOC_PATH = path.join(ROOT, 'docs', 'COMMANDS.md');
const HELP_FULL_PATH = path.join(ROOT, 'get-tasks-done', 'workflows', 'help', 'modes', 'full.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

describe('orchestrate-tasks selector resolution contract', () => {
  test('command prompt contract requires model-side issue resolution', () => {
    const content = read(COMMAND_PATH);

    assert.match(content, /exported manifest\s+metadata/i, 'command must mention exported manifest metadata');
    assert.match(content, /untrusted natural language/i, 'command must treat arguments as untrusted natural language');
    assert.match(content, /exact exported GitHub child issue numbers/i, 'command must require exact child issue numbers');
    assert.match(content, /Do not forward raw natural-language selectors/i, 'command must forbid raw natural-language selectors');
    assert.match(content, /task ids, `tasks \.\.\.`, phase/i, 'command must forbid task ids, tasks syntax, and phase selectors');
    assert.match(content, /orchestrate-tasks 123 124 125 --repo owner\/name --dry-run/i, 'command must show the canonical helper invocation');
    assert.match(content, /First run the Start Gate exactly once/i, 'command must require one canonical Start Gate invocation');
    assert.match(content, /`writes: false`/i, 'command must require dry-run no-write evidence');
    assert.match(content, /same exact issue\s+list/i, 'command must require mutating execution to reuse the checked issue list');
    assert.match(content, /Do not replace the\s+full-scope option with the recommended subset/i, 'command must forbid replacing full scope with recommended subset');
    assert.match(content, /checkpoint_gates/i, 'command must mention checkpoint gate output');
    assert.match(content, /Issue closure is the only hard resume signal|unblock only when the\s+checkpoint issue is closed/i, 'command must use issue closure as checkpoint signal');
    assert.match(content, /non_workable`? as the only hard-blocker field/i, 'command must distinguish hard blockers from sequencing');
    assert.match(content, /full-scope option[\s\S]*recommended_subset`? is advisory/i, 'command must keep full-scope continuation available');
  });

  test('workflow contract resolves natural language before the Node call', () => {
    const content = read(WORKFLOW_PATH);

    assert.ok(content.includes('Do not pass raw natural-language selectors'), 'workflow must forbid raw natural-language selectors');
    assert.ok(content.includes('the local plan file and exported manifest metadata'), 'workflow must require local plan + manifest lookup');
    assert.match(content, /exact exported GitHub child issue numbers/i, 'workflow must require exact child issue numbers');
    assert.ok(content.includes('Do not pass task ids, `tasks ...`, `next ...`, phase selectors, issue URLs, or'), 'workflow must forbid unsupported CLI inputs');
    assert.match(content, /Do not guess\s+and do not retry with a[\s\S]*second English phrasing/i, 'workflow must forbid trial-and-error loops');
    assert.match(content, /Run the deterministic planner exactly once with the exact issue list/i, 'workflow must require a single issue-list invocation');
    assert.ok(content.includes('all tasks in 01-03-PLAN'), 'workflow must document the example plan reference');
    assert.ok(content.includes('123 124 125'), 'workflow must show issue-number syntax');
    assert.ok(content.includes('report_orchestration_plan'), 'workflow must document dry-run to execution handoff');
    assert.ok(content.includes('agent_lanes_required'), 'workflow must document the agent lane handoff');
  });

  test('workflow contract requires a mandatory Start Gate before writes', () => {
    const content = read(WORKFLOW_PATH);

    assert.match(content, /Every new orchestration start[\s\S]*must pass the Start Gate/i, 'workflow must make the Start Gate mandatory');
    assert.match(content, /before any branch, issue claim, PR, comment, executor, or manifest write/i, 'workflow must place the Start Gate before all writes');
    assert.match(content, /orchestrate-tasks 123 124 125 --repo owner\/name --dry-run/i, 'workflow must run dry-run as the gate command');
    assert.ok(content.includes('`ok: true`'), 'workflow must require ok dry-run output');
    assert.ok(content.includes('`writes: false`'), 'workflow must require no-write dry-run output');
    assert.ok(content.includes('`preflight.ok: true`'), 'workflow must require preflight success');
    assert.match(content, /`selection_errors` is empty/i, 'workflow must reject selection errors');
    assert.match(content, /`non_workable` is empty/i, 'workflow must reject non-workable tasks');
    assert.match(content, /`dependency_order`[\s\S]*not a blocker/i, 'workflow must describe dependency order as sequencing');
    assert.match(content, /`checkpoint_gates`[\s\S]*not blockers or executor lanes/i, 'workflow must allow checkpoint gates without executor lanes');
    assert.match(content, /dependency waves are coherent/i, 'workflow must validate dependency waves');
    assert.match(content, /Do not omit the full-scope continue choice/i, 'workflow must forbid omitting full-scope continuation');
    assert.match(content, /same exact issue list/i, 'workflow must require mutating execution to reuse the checked issue list');
    assert.match(content, /--confirm-reviewability/i, 'workflow must document explicit oversized-scope confirmation');
  });

  test('workflow contract keeps reviewability direction from becoming a blocker prompt', () => {
    const content = read(WORKFLOW_PATH);

    assert.match(content, /Do not call reviewability concerns, dependency order,\s+or checkpoint gates blockers/i, 'workflow must forbid blocker wording for reviewability/dependencies/checkpoints');
    assert.match(content, /Continue with the full selected scope/i, 'workflow must offer full-scope continuation');
    assert.match(content, /Choose a smaller explicit scope/i, 'workflow must offer smaller explicit scope');
    assert.match(content, /recommended_subset`? only as advisory/i, 'workflow must keep recommended subset advisory');
    assert.match(content, /Do not omit the full-scope continue choice/i, 'workflow must not omit full-scope option');
    assert.match(content, /same exact issue list plus\s+`--confirm-reviewability`/i, 'workflow must document full-scope confirmation command');
  });

  test('help text clarifies that selection is handled by the interactive layer', () => {
    const commandsDoc = read(COMMANDS_DOC_PATH);
    const helpFull = read(HELP_FULL_PATH);

    assert.ok(commandsDoc.includes('Phase, plan, remaining-task, task-id, and other natural-language selection is'), 'COMMANDS.md must describe interactive-layer resolution');
    assert.ok(commandsDoc.includes('utility itself only accepts exact child issue numbers'), 'COMMANDS.md must state the utility contract');
    assert.match(commandsDoc, /not\s+selectors, task IDs, issue URLs, or `--phase`/, 'COMMANDS.md must forbid unsupported helper inputs');
    assert.ok(helpFull.includes('Phase, plan, remaining-task, task-id, and natural-language selection is resolved by the interactive layer before the utility call'), 'help text must describe interactive-layer resolution');
    assert.ok(helpFull.includes('`orchestrate-tasks` itself only accepts exact child issue numbers'), 'help text must state the utility contract');
  });

  test('help text documents the mandatory Start Gate', () => {
    const commandsDoc = read(COMMANDS_DOC_PATH);
    const helpFull = read(HELP_FULL_PATH);

    assert.match(commandsDoc, /mandatory Start Gate/i, 'COMMANDS.md must describe the mandatory Start Gate');
    assert.match(commandsDoc, /creating branches, claims, comments, PRs, or executors/i, 'COMMANDS.md must put Start Gate before writes');
    assert.match(commandsDoc, /runs the helper with `--dry-run`/i, 'COMMANDS.md must document the dry-run gate command');
    assert.match(commandsDoc, /same issue list/i, 'COMMANDS.md must require reusing the checked issue list');
    assert.match(commandsDoc, /Passing `--dry-run` reports the Start Gate result and stops/i, 'COMMANDS.md must describe dry-run stop behavior');
    assert.match(helpFull, /mandatory Start Gate with `--dry-run`/i, 'full help must describe the dry-run Start Gate');
    assert.match(helpFull, /mutating runs reuse the same checked issue list/i, 'full help must require same checked issue list');
    assert.match(helpFull, /`--dry-run` reports the Start Gate result and stops without writes/i, 'full help must describe dry-run stop behavior');
    assert.match(helpFull, /full selected scope as an explicit option/i, 'full help must keep full-scope continuation option');
  });

  test('docs describe human checkpoint gates as closure-based and non-executable', () => {
    const workflow = read(WORKFLOW_PATH);
    const commandsDoc = read(COMMANDS_DOC_PATH);
    const helpFull = read(HELP_FULL_PATH);

    assert.match(workflow, /Do not spawn an executor for checkpoint gates/i, 'workflow must forbid checkpoint executors');
    assert.match(workflow, /human_checkpoint_required/i, 'workflow must document checkpoint pause action');
    assert.match(workflow, /Issue closure is the only hard resume signal/i, 'workflow must use closure as the hard signal');
    assert.match(workflow, /comments are optional[\s\S]*must not block resume/i, 'workflow must keep comments non-blocking');
    assert.match(workflow, /Never close checkpoint issues\s+from the final PR/i, 'workflow must keep final PR from closing checkpoints');
    assert.match(commandsDoc, /Human checkpoint tasks stay in scope as non-executable gates/i, 'COMMANDS.md must describe checkpoint gates');
    assert.match(commandsDoc, /Comments are optional audit evidence and are not hard blockers/i, 'COMMANDS.md must keep comments non-blocking');
    assert.match(commandsDoc, /recommended subset is only advisory/i, 'COMMANDS.md must keep recommended subset advisory');
    assert.match(helpFull, /non-executable gates[\s\S]*GitHub issue is closed/i, 'full help must describe closure-based checkpoint gates');
  });

  test('checkpoint pause output uses user-facing next-step text, not internal helper commands', () => {
    const workflow = read(WORKFLOW_PATH);
    const command = read(COMMAND_PATH);
    const outputContract = (workflow.match(/<output_contract>([\s\S]*?)<\/output_contract>/i) || [])[1] || '';
    const checkpointStep = workflow.slice(workflow.indexOf('16. When checkpoint-paused output'));

    assert.match(command, /When checkpoint-paused output includes `user_next_step`/i, 'command must use safe next-step metadata');
    assert.match(command, /do not ask the user to run internal helper\s+commands/i, 'command must forbid user-facing helper commands');
    assert.match(outputContract, /`user_next_step\.message` for checkpoint pauses/i, 'output contract must use safe next-step message');
    assert.match(outputContract, /do not ask the user to run\s+internal helper commands/i, 'output contract must forbid helper commands');
    assert.doesNotMatch(outputContract, /--resume|gtd-tools|node "\$HOME/i, 'output contract must not include raw resume commands');
    assert.doesNotMatch(checkpointStep, /orchestrate-tasks --resume|gtd-tools\.cjs" orchestrate-tasks --resume/i, 'checkpoint pause step must not tell the user to run raw resume commands');
  });
});

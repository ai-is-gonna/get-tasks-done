# Configuration

GTD stores project settings in `.planning/config.json`. Most users can keep the
defaults created by `/gtd-new-project` and adjust settings through `/gtd-config`.

## Common Settings

| Key | Type | Default | Purpose |
|---|---:|---:|---|
| `runtime` | string | detected | Preferred runtime integration. |
| `workflow.discuss_mode` | string | `discuss` | Controls whether discussion uses interview-style questions or assumption review. |
| `workflow.research` | boolean | `true` | Enables research before planning when useful. |
| `workflow.plan_chunked` | boolean | `true` | Allows large phases to be planned in smaller reviewable chunks. |
| `workflow.plan_check` | boolean | `true` | Runs plan quality checks before execution. |
| `workflow.plan_review_convergence` | boolean | `false` | Enables repeated plan review until configured convergence checks pass. |
| `workflow.nyquist_validation` | boolean | `true` | Enables independent validation for non-trivial plans. |
| `workflow.ui_phase` | boolean | `true` | Enables UI-specific planning and review when frontend changes are detected. |
| `workflow.ui_review` | boolean | `true` | Enables UI review after task issue work when relevant. |
| `workflow.drift_threshold` | number | `3` | Sets how much source drift is tolerated before GTD asks for reconciliation. |
| `workflow.drift_action` | string | `warn` | Controls whether source drift warns, blocks, or asks before continuing. |
| `model_profile` | string | `balanced` | Selects the default model budget profile. |
| `models.<phase_type>` | string | unset | Optional per-phase-type model override. |
| `model_overrides.<agent>` | string | unset | Optional per-agent model override. |
| `review.default_reviewers` | array | unset | Limits default `/gtd-code-review` reviewers when configured. |
| `review.ollama_host` | string | unset | Optional Ollama host for local review models. |
| `review.lm_studio_host` | string | unset | Optional LM Studio host for local review models. |
| `review.llama_cpp_host` | string | unset | Optional llama.cpp host for local review models. |
| `review.models.ollama` | string | unset | Optional Ollama model name for local review. |
| `review.models.lm_studio` | string | unset | Optional LM Studio model name for local review. |
| `review.models.llama_cpp` | string | unset | Optional llama.cpp model name for local review. |
| `graphify.enabled` | boolean | `false` | Enables codebase graph generation. |
| `statusline.context_position` | string | `right` | Controls where context usage appears in the statusline. |

## GitHub Task Issue Workflow

The current workflow uses GitHub Issues and PRs as the public review boundary.
Repository targeting is normally inferred from the current project. Use command
flags such as `--repo owner/repo` only when detection is missing or ambiguous.

Relevant commands:

```bash
/gtd-export-phase-issues <phase> --repo owner/repo
/gtd-work-task-issue --phase <phase> --repo owner/repo
```

## Model Profiles

Use `model_profile` for broad defaults:

| Value | Intent |
|---|---|
| `quality` | Prefer stronger models for planning, review, and verification. |
| `balanced` | Default balance of quality and cost. |
| `budget` | Prefer lower-cost models where safe. |
| `inherit` | Let the host runtime choose when possible. |

Use targeted overrides only when a specific agent or phase type needs different
behavior.

## Runtime Notes

GTD supports multiple AI coding runtimes. Runtime-specific installation paths
and generated files are handled by the installer. Prefer command-level config
over manually editing generated runtime files.

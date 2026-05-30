<purpose>
Review open GitHub issues and pull requests for basic triage signals. Produce a
concise report that helps the maintainer decide what to answer, label, or merge.
</purpose>

<required_reading>
Before starting, read:
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/ISSUE_TEMPLATE/docs_issue.yml`
- `.github/pull_request_template.md`
- `CONTRIBUTING.md`
</required_reading>

<process>

<step name="preflight">
Verify prerequisites:

```bash
which gh && gh auth status 2>&1
```

Detect the repository from `--repo owner/name` when provided. Otherwise use:

```bash
gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null
```

If no repository is available, stop and explain that GitHub triage needs a
repository context.
</step>

<step name="fetch">
Fetch open issues and PRs:

```bash
gh issue list --state open --json number,title,labels,body,author,createdAt,updatedAt --limit 100
gh pr list --state open --json number,title,labels,body,author,createdAt,updatedAt,isDraft,reviewDecision,mergeable,statusCheckRollup --limit 100
```
</step>

<step name="review_issues">
For each issue, classify it as one of:
- bug
- feature/request
- docs
- question/support
- unclear

Check whether the report contains enough information to act:
- clear expected behavior
- current behavior or limitation
- reproduction steps for bugs
- version/runtime/OS when relevant
- logs or screenshots when useful

Do not enforce approval labels or close incomplete issues automatically. If an
issue is unclear, recommend one specific follow-up question.
</step>

<step name="review_prs">
For each pull request, check:
- summary explains the user-visible or maintainer-visible change
- tests or validation are listed
- scope is focused
- status checks are visible and passing, failing, or pending
- linked issue exists when the PR clearly fixes a filed issue

Do not reject PRs for missing approved labels. Treat missing issue links as a
triage note, not a gate.
</step>

<step name="report">
Return a maintainer-focused report:

1. Items needing maintainer attention first.
2. PRs blocked by failing or pending checks.
3. Issues that need more information, with the exact question to ask.
4. Low-risk issues or PRs that can be handled quickly.
5. Suggested labels, if obvious.

Keep recommendations manual by default. Only apply labels or comments if the
user explicitly requested mutation.
</step>

</process>

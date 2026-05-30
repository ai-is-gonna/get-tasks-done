# Contributing

Thanks for considering a contribution to Get Tasks Done.

This project is early in its public life. The contribution process is intentionally light: open an issue when useful, keep pull requests focused, and include enough validation for the change to be reviewed confidently.

## Local Setup

```bash
git clone https://github.com/ai-is-gonna/get-tasks-done.git
cd get-tasks-done
npm ci
npm test
```

Node.js 22 or newer is required.

## Development

- Read [Contributor Standards](docs/contributor-standards.md) before larger code or documentation changes.
- Keep changes focused on one concern.
- Prefer small pull requests with a clear summary and test notes.
- Add or update tests for behavior changes.
- Avoid drive-by formatting or unrelated refactors.
- Do not commit local runtime state, generated planning data, credentials, or logs.

## Tests

Use the existing test style:

- Node.js built-in `node:test`
- `node:assert/strict`
- shared helpers from `tests/helpers.cjs` where applicable

Useful commands:

```bash
npm test
npm run test:coverage
npm run build:sdk
```

For installer or packaging changes, also verify a packed install path with `npm pack` before release.

## Pull Requests

Every pull request should include:

- what changed
- why it changed
- how it was tested
- any compatibility or migration notes

An issue link is welcome but not required for small fixes. Larger features should start with an issue so the design can be discussed before implementation.

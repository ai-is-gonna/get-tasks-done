# Versioning and Releases

Get Tasks Done uses Semantic Versioning.

## Version Policy

- Patch: bug fixes and documentation corrections.
- Minor: backward-compatible enhancements and new commands.
- Major: breaking changes to command behavior, configuration, generated files, or SDK APIs.

## Release Process

Releases are manual for the first public phase:

1. Confirm `main` is green.
2. Update package versions intentionally.
3. Run `npm ci`, `npm run build:sdk`, `npm test`, and package smoke checks.
4. Tag the release as `vX.Y.Z`.
5. Create a GitHub release.
6. Publish `@ai-is-gonna/get-tasks-done` and `@ai-is-gonna/gtd-sdk` to npm when applicable.

No canary, next, hotfix, or release-branch automation is part of the public launch setup.

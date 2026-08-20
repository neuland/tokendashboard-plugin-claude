# ADR-002: Distribution via npx and Git

## Decision

Distribute as an npm package via `npx` with a Git URL pointing at the repo:

```bash
npx git+https://github.com/neuland/tokendashboard-plugin-claude.git install --api-base-url <url> --repo-raw-base-url <url>
```

`updater.js` is the `bin` entry in `package.json` and handles install/uninstall. `--api-base-url` and `--repo-raw-base-url` are covered in ADR-016.

## Why

- A single command handles install and uninstall; no manual `settings.json` editing.
- Install/uninstall is idempotent — running it multiple times does not create duplicate hook entries.
- Users need Git access to the repo for the one-time install and for updates (npx pulls from Git, not the public npm registry).
- Auto-update (ADR-012) rewrites `settings.json` on drift and fetches lifecycle logic fresh each update, so most changes roll out without re-running `npx`. Only `package.json`
  changes still require a manual re-run.

## Alternatives considered

- **Manual `settings.json` editing**: error-prone, too much effort for end users.
- **Git-host npm registry (GitLab/GitHub Packages)**: requires one-time registry setup per machine.
- **Shell script via curl**: less trustworthy, harder to version.
- **Public npm registry**: would work but adds no benefit over the Git URL for this distribution model.

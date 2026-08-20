# ADR-010: $HOME-Relative Hook Path in settings.json

## Decision

The hook command in `~/.claude/settings.json` uses a `$HOME`-relative path rather than an absolute one, whenever the script lives under the home directory on a POSIX platform:

```
node "$HOME/.claude/token-usage-plugin/hook.js"
```

On Windows, or when the resolved hook path is not under `os.homedir()` (a custom `CLAUDE_CONFIG_DIR` outside `$HOME`), the installer falls back to an absolute path.

`removeOwnHooks` matches our entries by the substring `token-usage-plugin` (unique to this plugin, and present in both current and legacy commands), not by absolute path or
filename alone — this must stay a substring match to recognize entries written by any historical version.

## Why

- Hook commands run via `sh -c`, which expands `$HOME` — the same `settings.json` then resolves correctly both on the host and inside a Linux devcontainer where `~/.claude` is
  mounted at a different `$HOME`. An absolute path baked in on one machine breaks on the other.
- Double-quoted `~` does not expand in `sh` (`"~/.claude"` stays literal); `$HOME` does, so the path stays safely quoted against spaces while still resolving.
- `cmd.exe` (native Windows) uses `%VAR%`, not `$VAR`, and typically has no `HOME` set — there's no single command string that expands correctly in `sh`, PowerShell, and `cmd.exe`
  alike. A native Windows install runs the installer locally and gets a correct absolute path with no cross-environment sharing need, so the absolute fallback is correct there.
- This `$HOME`-relative string must be **identical** across host and devcontainer: ADR-012's automatic settings write uses it as the drift key, and a divergence would cause the two
  environments to repeatedly overwrite each other's `settings.json`.
- `${CLAUDE_PLUGIN_ROOT}` would be the cleaner long-term fix (substituted by Claude Code itself, fully shell/OS-independent) but requires migrating to the marketplace plugin
  distribution model — out of scope for this installer-based approach.

## Alternatives considered

- **Absolute paths, reinstall per environment**: defeats the purpose of a shared mounted `~/.claude`.

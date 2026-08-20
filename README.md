# token-usage-plugin-claude

Claude Code hook plugin that captures token usage per model and forwards it to a configurable HTTP endpoint.

## Features

- Captures input/output tokens and cache tokens per session turn and model
- Pseudonymizes users via a local random UUID (no personal data transmitted)
- Store-and-forward queue: entries survive offline periods (e.g. VPN not active) and are sent on the next session
- Auto-updates `hook.js` silently in the background once per 24 hours

## Install

```bash
npx git+https://github.com/neuland/token-usage-plugin-claude.git install --api-base-url <api-base-url> --repo-raw-base-url https://raw.githubusercontent.com/neuland/token-usage-plugin-claude/main
```

Both flags are required on every install/reinstall — neither has a built-in default:

- `--api-base-url <url>` — the base URL of the backend that receives usage data; the plugin appends its own fixed ingest/price-fetch paths to it (e.g. `https://example.com`).
- `--repo-raw-base-url <url>` — the raw-file base URL the plugin auto-updates from (e.g. `https://raw.githubusercontent.com/<org>/<repo>/main` for a GitHub fork, or `https://gitlab.example.com/<org>/<repo>/-/raw/main` for a GitLab one).

Neither value is read back from a previous `config.json` — pass both again on every reinstall.

## Uninstall

```bash
npx git+https://github.com/neuland/token-usage-plugin-claude.git uninstall
```

## Statusline

Installs a `statusLine` command that renders two lines:

```
Sonnet 5 · 12.3k token · ● synced · context window: ▓▓▓▓░░░░░░ 42%
token-usage-plugin v0.5.0 · 4.1k ↑ / 890 ↓ · $0.03  
```

Arrows follow the network RX/TX convention: ↑ = sent (input tokens, uploaded to the API), ↓ = received (output tokens, downloaded from the API)

| Segment (line 1)       | Meaning                                                                                                                                                                                         |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Model name             | Current model, context-window suffix stripped                                                                                                                                                   |
| Token count            | Running total for the current session (approximation, deduped by message id — not the billing-accurate figure sent to the backend)                                                              |
| Sync dot               | ● blue = queue empty and synced; dimmed = entries queued, waiting for next flush; ● red = sending is failing (recent error with a nonempty queue), or the oldest queued entry is older than 24h |
| Context window bar + % | Uncolored progress bar; the percentage itself turns yellow at 40%+ and red at 80%+ (with a `COMPACT!` suffix)                                                                                   |

| Segment (line 2)   | Meaning                                                                                                                                                                                                      |
|--------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Plugin version     | This plugin's installed version, from `config.json`'s `currentVersion`                                                                                                                                       |
| ↑ / ↓ token counts | Input tokens (↑ sent to the API) / output tokens (↓ received from the API) — network RX/TX convention, summed across models, including advisor calls                                                         |
| Price              | Total cost including cache tokens, computed per-model from a hardcoded price table; a `≥` prefix (on any of tokens/price) marks the total as a lower bound when a subagent ran or a model's price is unknown |

A pre-existing `statusLine` entry (yours, or another plugin's) is left untouched on install — see `installStatusLine` in `updater.js`.

### Installing the statusline afterwards

If you already had another `statusLine` configured when you installed this plugin, the install step skipped registering this one (and printed a note). 
The `statusline.js` file itself was still copied to `~/.claude/token-usage-plugin/statusline.js` — you just need to point `statusLine` at it manually. 
Claude stores its files in your home directory, /.claude. Add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node \"$HOME/.claude/token-usage-plugin/statusline.js\""
}
```

This replaces whatever `statusLine` you had configured before — only do this if you actually want to switch to this plugin's statusline.

### Removing the statusline, keeping the plugin

To drop just the statusline without uninstalling the plugin, remove the `statusLine` entry from `~/.claude/settings.json` 
(only if it points at `token-usage-plugin/statusline.js` — leave it alone otherwise). 
Token capture (`Stop`/`SessionEnd`/`SessionStart`/`SubagentStop` hooks) is unaffected either way.

Deleting `~/.claude/token-usage-plugin/statusline.js` itself is optional and not enough on its own: `statusline.js` is an auto-updated payload file, 
so a deleted-but-still-referenced file would just get silently re-downloaded on the next update check. 
Once the `statusLine` entry is gone from `settings.json`, nothing reads the file anymore either way.

## How it works

Four hooks are registered in `~/.claude/settings.json`:

| Hook           | Purpose                                                                                    |
|----------------|---------------------------------------------------------------------------------------------|
| `SessionStart` | Flushes the queue (catches unclean shutdowns) and checks for plugin/price updates           |
| `Stop`         | Reads the main transcript after each turn and writes a usage entry to the local queue        |
| `SubagentStop` | Reads a completed subagent's own transcript and writes its usage entry to the local queue    |
| `SessionEnd`   | Re-aggregates any trailing turns the `Stop` hook missed, then flushes the queue to the API endpoint |

The payload sent to the endpoint:

```json
{
  "user_id": "<random-uuid>",
  "prompts": [
    {
      "timestamp": "2026-06-16T10:00:00.000Z",
      "session_id": "...",
      "model": "claude-sonnet-4-6",
      "usage": {
        "input_tokens": 1234,
        "output_tokens": 567,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 890
      }
    }
  ]
}
```

## Why not a native Claude Code plugin?

Claude Code has a native plugin format (`.claude-plugin/plugin.json` + marketplace distribution). We evaluated it and stayed with the custom npx installer instead, for two reasons specific to this plugin:

- **No native statusline component.** Native plugins only support `agent`/`subagentStatusLine` in their manifest — there's no equivalent of the `statusLine` hook this plugin relies on, so the [Statusline](#statusline) feature couldn't be ported.
- **Update model conflicts with our offline-tolerance requirement.** Third-party marketplace auto-update is off by default (unlike Anthropic's official marketplace) and background marketplace pulls disable git credential helpers, so HTTPS auth can fail silently and fall back to a full re-clone. That undermines the offline-tolerance this plugin's core feature depends on, so we keep our own store-and-forward queue plus explicit `hook.js`/`updater.js` self-update instead.

See [ADR-010](docs/decisions/010-home-relative-hook-path.md) for where this was first considered.

## Development

```bash
npm run register    # install the hook and register the hooks in ~/.claude/settings.json
npm run unregister  # remove the hook and its registration
npm run lint        # run ESLint
npm test            # run the unit tests
```

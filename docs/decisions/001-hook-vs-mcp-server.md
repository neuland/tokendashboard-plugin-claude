# ADR-001: Claude Code Hook over MCP Server

## Decision
Token usage is captured via the Claude Code hook system, not an MCP server.

## Why
- Hooks fire automatically on every interaction; an MCP server would require Claude to actively decide to call a logging tool, which breaks gap-free tracking.
- Claude itself has no access to the logged data — this is a deliberate side effect of the hook-only design.

## Alternatives considered
- **MCP server**: flexible and queryable, but no automatic capture.
- **Hybrid (hook + MCP server)**: would make sense only if a query interface ("how many tokens this week?") is needed later.

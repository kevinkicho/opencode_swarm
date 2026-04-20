# opencode SDK vocabulary

Canonical strings used by opencode's TypeScript SDK. This prototype's timeline, filters, and mock data should use these — not invented equivalents.

**Source of truth:** `github.com/sst/opencode` — `packages/sdk/js/src/gen/types.gen.ts`
**Docs:** `opencode.ai/docs/sdk/`
**Last pulled:** 2026-04-19 (verify before shipping — opencode moves fast)

---

## Event types (SSE stream)

Subscribed via `event.subscribe()` / `event.listen()`.

### Session lifecycle

- `session.created`
- `session.updated`
- `session.deleted`
- `session.status` — status changed (see **Session status** below)
- `session.idle` — session finished working
- `session.compacted` — context was compacted
- `session.diff` — diff available for the session
- `session.error` — session errored

### Message / part streaming

- `message.updated`
- `message.removed`
- `message.part.updated` — part added or changed (primary streaming event)
- `message.part.removed`
- `message.part.delta` — incremental delta for streaming text/reasoning

### Permission (human-in-the-loop)

- `permission.updated`
- `permission.replied`
- `permission.asked`

### Question (agent asks user)

- `question.asked`
- `question.replied`
- `question.rejected`

### File / VCS

- `file.edited`
- `file.watcher.updated`
- `vcs.branch.updated`

### Other

- `lsp.client.diagnostics`
- `lsp.updated`
- `todo.updated`
- `command.executed`
- `pty.created`
- `pty.updated`
- `pty.exited`
- `pty.deleted`

### TUI (client-specific)

- `tui.prompt.append`
- `tui.command.execute`
- `tui.toast.show`

### Server / installation

- `server.connected`
- `server.instance.disposed`
- `server.heartbeat` — every 10s, keeps proxy connections alive
- `installation.updated`
- `installation.update-available`
- `project.updated`

---

## Message Part types

The `type` discriminator on a message part. These are the primary timeline units.

- `text` — model text output (markdown)
- `reasoning` — internal model thought (often collapsed)
- `tool` — tool call + result (see **Tools** below)
- `file` — attached file or file reference
- `agent` — reference to a specific sub-agent
- `subtask` — delegated sub-work
- `step-start` — step boundary start (git snapshot checkpoint)
- `step-finish` — step boundary end
- `snapshot` — captured working-tree state
- `patch` — code change / diff
- `retry` — retry marker
- `compaction` — context-compaction marker

---

## Session status

Values emitted on `session.status`.

- `idle`
- `busy`
- `retry`

---

## Tool state

ToolPart lifecycle stages.

- `pending`
- `running`
- `completed`
- `error`

---

## Built-in tools

Registered in opencode's ToolRegistry. These are the canonical `toolName` values on a ToolPart.

- `bash` — execute shell command
- `read` — read a file or directory
- `write` — overwrite a file
- `edit` — string-replacement edit of a file
- `list` — list directory contents recursively
- `grep` — ripgrep across file contents
- `glob` — file pattern matching
- `webfetch` — fetch URL, convert to agent-friendly format
- `todowrite` — write / update todo list
- `todoread` — read todo list
- `task` — **delegate to a sub-agent** (opencode's native A2A primitive)

---

## SDK method surface (partial)

Client classes: `Global`, `Config`, `Auth`, `Project`, `Session2`, `Part`, `Permission`, `Question`, `Provider`, `Tool`, `Pty`, `Worktree`, `Experimental`.

Session: `list` `get` `children` `create` `delete` `update` `init` `abort` `share` `unshare` `summarize` `messages` `message` `prompt` `command` `shell` `revert` `unrevert`

Files: `find.text` `find.files` `find.symbols` `file.read` `file.status`

Events: `event.subscribe`

TUI: `tui.appendPrompt` `tui.openHelp` `tui.openSessions` `tui.openThemes` `tui.openModels` `tui.submitPrompt` `tui.clearPrompt` `tui.executeCommand` `tui.showToast`

Config: `config.get` `config.providers`

App / Project: `app.log` `app.agents` `project.list` `project.current`

Auth: `auth.set`

---

## Notes for this prototype

- opencode has **no A2A typed-pin schema**. Sub-agent communication happens through the `task` tool plus `subtask` / `agent` parts.
- What we previously called "thinking" is `reasoning`.
- What we previously called "diff" is `patch` (part) or `session.diff` / `file.edited` (event).
- What we previously called "shell" is the `bash` tool + `command.executed` event, not a first-class pin.
- `permission.*` is a real, important signal for "waiting on human approval" — treat as a first-class chip in the UI.
- `compaction` is a first-class part type — worth a dedicated timeline marker.

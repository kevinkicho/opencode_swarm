# opencode quirks

What this prototype assumes about opencode's HTTP API and runtime behavior.
Most of these contracts are **implicit** — not in opencode's public docs. We
learned them by probing a live daemon and from incidents (catalog'd in
`docs/POSTMORTEMS/`). Read this file before wiring a new opencode call site.

When opencode surprises us in a way that breaks a run, we file a postmortem
and link the cross-reference here.

---

## 1. Vocabulary

Source: `github.com/sst/opencode` — `packages/sdk/js/src/gen/types.gen.ts`
at tag `v1.14.28` (2026-04-27 audit).

**Message part types** (atoms of the timeline):

`text` `reasoning` `tool` `file` `agent` `subtask` `step-start` `step-finish`
`snapshot` `patch` `retry` `compaction`

**Tool names** (built-in primitives, from `GET /experimental/tool/ids`):

`bash` `read` `write` `edit` `apply_patch` `grep` `glob` `codesearch`
`webfetch` `websearch` `todowrite` `task` `question` `skill`

`task` is opencode's native A2A primitive. There is **no separate
"agent message" type** — sub-agent communication is `task` invocations
plus `subtask` parts. `apply_patch` is the patch-apply path that complements
the string-replace `edit` tool. `question` is a first-class interactive
prompt (the agent asking the user for clarification — not a free-form text
turn). The pre-v1.14 `list` and `todoread` tools were removed; use `glob`
in place of `list`, and `todowrite` round-trips state so no separate read
is needed.

**SSE event stream** the UI can subscribe to (we filter to the subset
relevant to swarm coordination — TUI/PTY/installation/lsp events are
emitted but ignored):

```
session.{created,updated,deleted,status,idle,compacted,diff,error}
message.{updated,removed}
message.part.{updated,removed}
permission.{updated,replied}
file.edited · file.watcher.updated · vcs.branch.updated
todo.updated · command.executed
server.{connected,instance.disposed}
```

Notes:
- `permission.asked` does **not** exist in v1.14 — the asked state arrives
  via `permission.updated` (the SDK collapsed ask + state-change into one
  channel). `permission.replied` is fired separately on resolution.
- `question.{asked,replied,rejected}` do **not** exist — `question` is now
  a tool, not an event family.
- `message.part.delta` does **not** exist — only `updated` and `removed`.
- `server.heartbeat` does **not** exist — only `connected` and
  `instance.disposed`.
- `project.updated` does **not** exist.

**Session status:** `idle` `busy` `retry`
**Tool state:** `pending` `running` `completed` `error`

**Built-in agents** (verified against v1.14 SDK): `build`, `compaction`,
`explore`, `general`, `plan`, `summary`, `title`. Plus any from user's
`opencode.json`.

---

## 2. Connection + auth

`OPENCODE_URL` = `http://172.24.32.1:4097` in dev (Windows host from WSL).
Daemon listens on `4097` not the default `4096` to stay isolated from a
sibling app. Launcher (Windows Startup `.vbs`) auto-fires at logon.

**Auth.** HTTP Basic via `OPENCODE_BASIC_USER` / `OPENCODE_BASIC_PASS`.
Without them every endpoint returns 401.

**Process locality.** opencode is Windows-native. WSL `ss -tlnp` can't see
it — verify via `netstat.exe -ano | grep :4097`. Multiple `opencode.exe`
may run (IDE extensions, CLI sessions) — never blind-kill.

---

## 3. Workspace path encoding

opencode is Windows-native. Every API call that takes a workspace path
expects **Windows-native** format (`C:\Users\kevin\Workspace\foo`). Our
app stores workspaces in this format in `meta.workspace`.

**WSL-side translation:** when Node code (Next.js under WSL) reads files
from the workspace, it must translate
`C:\Users\kevin\Workspace\foo` → `/mnt/c/Users/kevin/Workspace/foo`.
Helper: `lib/server/blackboard/planner/_shared.ts::toNodeReadablePath`.

| Use case | Format |
|---|---|
| Pass to opencode (`?directory=`, session `directory` field) | Windows |
| `fs.readFile` / Node `path.resolve` from server code | WSL-translated |
| Workspace shown to user in our UI | Windows (matches Explorer / VSCode) |

Forgetting either direction is a silent failure. The session won't error —
it just won't read the file.

---

## 4. Endpoints we call

### Core (primary call path for every run)

| Verb · Path | What we use it for | Quirks |
|---|---|---|
| `POST /session?directory=<path>` | Create a session in a workspace | Body: `{ title? }`. |
| `GET /session?directory=<path>` | List per-workspace sessions | **Bare `GET /session` returns ONLY global sessions** (`projectID="global"`). Per-project needs `?directory=`. List order **drifts between polls** — sort by `id` for stability. |
| `GET /session/{id}?directory=<path>` | Single-session lookup | Works regardless of project scope. |
| `GET /session/{id}/message?directory=<path>` | Fetch all messages | No pagination, no since-cursor — diff client-side via `knownIDs` Set. |
| `GET /session/{id}/diff?directory=<path>` | Aggregate file changes | **`?messageID=` and `?hash=` are accepted but IGNORED** — always returns session-aggregate. Per-turn granularity lives in `patch` parts' `files` field only. |
| `POST /session/{id}/abort?directory=<path>` | Cancel in-flight turn | Soft cancel (already-dispatched tools finish, no further reasoning). Idempotent on idle. |
| `POST /session/{id}/prompt_async?directory=<path>` | Send a prompt fire-and-forget | The danger zone — see §5. |
| `GET /agent?directory=<path>` | List agents | Built-ins + user's `opencode.json`. |
| `GET /event?directory=<path>` | SSE event stream | EventSource auto-reconnects. |
| `GET /permission?directory=<path>` | Pending permission requests | Only populated under permission gating; we run allow-all. |
| `POST /session/{id}/permissions/{permissionID}?directory=<path>` | Reply to a permission request | Body `{ response: 'once'\|'always'\|'reject' }`. **Replaced** the pre-v1.14 `POST /permission/{id}/reply` (body field was `reply`). |

### Diagnostics + supplementary surfaces (v1.14)

| Verb · Path | What we use it for |
|---|---|
| `GET /experimental/tool/ids?directory=<path>` | Live tool catalog — cross-checks `ToolName` at startup |
| `GET /config?directory=<path>` | Effective opencode.json (theme, watcher ignores, share policy, …) |
| `GET /mcp?directory=<path>` | MCP server status map |
| `GET /command?directory=<path>` | User-defined commands from opencode.json |
| `GET /session/{id}/children?directory=<path>` | Direct children of a session (sub-agent forks) |
| `GET /session/{id}/todo?directory=<path>` | Session-scoped todo list (cross-check against blackboard plan) |
| `POST /session/{id}/summarize?directory=<path>` | Manually trigger summarization for long-running sessions |

We use `prompt_async` exclusively (sync prompt would force a long-held HTTP
connection). Authentication = out of scope (personal use, never SaaS).

---

## 5. `prompt_async` — the silent-failure surface

Body shape:

```ts
{
  parts: [{ type: 'text', text: '...' }],
  agent?: string,         // OPTIONAL — see §5a
  model?: { providerID, modelID }, // NOT a bare string — see §5b
}
```

**Returns 200 / 204 even when the prompt is silently dropped.** The HTTP
status lies; the truth is in whether a new user message + assistant turn
appears in `/session/{id}/message` afterwards. F1 silent-turn watchdog
(`lib/server/blackboard/coordinator/wait.ts::waitForSessionIdle`) is our
defense.

### 5a. The `agent` silent-drop trap

If the `agent` value is NOT in opencode's built-in list AND not in the
user's `opencode.json`, the POST returns 204 success but **never persists
the user message and never starts an assistant turn**. The session sits
forever; F1 declares `opencode-frozen` after ~240s.

**Default: don't pass `agent`.** Role display in our UI comes from
`roleNamesBySessionID(meta)`, not opencode's metadata. Agent-less dispatch
is the safe default.

**Exception:** `'orchestrator'` works despite not being a built-in. Reason
unknown — kept for orch-worker kickoff because it works empirically.

**Diagnostic probe:** if a session shows `msgs` not growing after a POST
that returned 200/204, send the same prompt without `agent`. If it lands,
the agent name was the culprit.

### 5b. Model format

`model` is **NOT a bare string**. It's `{ providerID, modelID }`. We parse
`<provider>/<modelID>` (canonical catalog format) into the object shape
inside `postSessionMessageServer` before posting.

- `ollama/glm-5.1:cloud` → `{ providerID: 'ollama', modelID: 'glm-5.1:cloud' }`
- `opencode-go/glm-5.1` → `{ providerID: 'opencode-go', modelID: 'glm-5.1' }`
- `claude-sonnet-4-6` (no slash) → `{ providerID: 'opencode', modelID: 'claude-sonnet-4-6' }`

If `agent` AND `model` are both set, **opencode's agent-config takes
precedence** — the named agent's configured model overrides the direct hint.

### 5c. Started-but-never-completed

User message persists. Assistant turn starts (`info.time.created`). But
`info.time.completed` stays null forever; no parts arrive.

**Most common cause:** Zen rate-limit (HTTP 429 `FreeUsageLimitError`).
opencode logs the 429 server-side but doesn't propagate through the session
API. Diagnosed by `grep 'statusCode":429' <opencode-log-file>`.

**Other causes:** session-context overflow (we preflight at 85% limit),
tool-loop on a structurally-broken call (gemma4 fixating on `edit` with a
bad `oldString` — F1 watchdog detects and aborts).

---

## 6. Zombie assistant turns

Assistant turns can hang in:
- `info.time.created` set
- `info.time.completed` null
- `info.error` unset (no signaled failure)
- No new parts

Naive liveness checks (`!time.completed` = running) render these as active
forever. Our defenses:

- **F1 watchdog** (`waitForSessionIdle`) — declares `silent` after silence
  threshold, aborts the session.
- **F4 reachability probe** — when silence ≥ 30s, probes ollama's `/api/ps`.
  Unreachable → return `provider-unavailable` immediately.
- **Run-level liveness** — `lib/server/swarm-registry/derive.ts` requires
  `ZOMBIE_THRESHOLD_MS` (10 min) past `time.created` before classifying a
  no-completed-no-error session as `stale`.

---

## 7. Things that change at runtime

- **Session list order** drifts between bare-`GET /session` polls. Sort by
  immutable `id` for stable rendering.
- **`/agent` list** — assumed stable for the lifetime of an opencode
  process. Built-ins are; user-defined only change if the user edits
  `opencode.json` while opencode is running. Untested.
- **`/event` SSE backpressure** — no dropped events observed at prototype
  scale (~10 sessions × 3 turns/min). Heavy-load behavior unknown.

---

## 8. Wiring checklist (new opencode call site)

1. Read this file first. §4 for verb/path/quirks.
2. **Don't pass `agent` unless validated.** Use `roleNamesBySessionID` for
   our display; if you NEED agent, verify it's in built-ins OR loaded into
   the session's project's `opencode.json`.
3. **Use `{ providerID, modelID }` for `model`.** A bare string is silently
   mis-routed to `providerID: 'opencode'`.
4. **Respect path encoding.** Windows to opencode, WSL-translated to `fs`.
5. **Treat HTTP 200/204 as "request accepted," not "work done."** Verify
   the side effect (new message, ticker outcome) before declaring success.
6. **Wrap waits in F1-style watchdog.** `waitForSessionIdle` is canonical.
7. **Log enough to file a postmortem.** dev-server.log + opencode log
   timestamp + dev message IDs + run ID + the exact request body.

---

## 9. Notes for this prototype

- opencode has **no A2A typed-pin schema**. Sub-agent communication = `task`
  tool + `subtask` / `agent` parts. The timeline has exactly one wire style.
- What we previously called "thinking" is `reasoning`.
- What we previously called "diff" is `patch` (part) or `session.diff` /
  `file.edited` (event).
- What we previously called "shell" is `bash` tool + `command.executed`
  event, not a first-class pin.
- `permission.*` is a real signal for "waiting on human approval" — first-
  class chip in the UI.
- `compaction` is a first-class part type — dedicated timeline marker.

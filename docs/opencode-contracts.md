# opencode contracts

What this prototype assumes about opencode's HTTP API and runtime behavior.
Most of these contracts are *implicit* — they're not in opencode's public docs.
We learned them by probing a live daemon and from incidents (catalog'd in
`docs/POSTMORTEMS/`). Read this file before wiring a new opencode call site so
you don't trip the same silent failures we already paid for.

This catalog is the companion to:
- `docs/opencode-vocabulary.md` — canonical part / event / tool names
- `docs/POSTMORTEMS/` — per-incident forensic reports
- `docs/API.md` — *our* HTTP API; this file is opencode's

When opencode's behavior surprises us in a way that broke a run, we file a
postmortem and link the cross-reference here.

---

## 1. Connection + auth

**`OPENCODE_URL`** — `http://172.24.32.1:4097` in dev (Windows host from WSL).
Default-fallback in `lib/opencode/client.ts` is `localhost:4096` but the real
daemon listens on `4097` per `memory/reference_opencode_port.md`. The
launcher (Windows Startup `.vbs`) auto-fires at logon —
`memory/reference_opencode_4097_launcher.md` documents the relaunch path.

**Authentication** — HTTP Basic, credentials in `OPENCODE_BASIC_USER` /
`OPENCODE_BASIC_PASS`. Without them every endpoint returns
`401 Unauthorized · WWW-Authenticate: Basic realm="Secure Area"`.

**Process locality** — opencode is a Windows-native `opencode.exe`. WSL
processes can't see it via `ss -tlnp` — verify presence via
`netstat.exe -ano | grep :4097`. Multiple `opencode.exe` may be running
(IDE extensions, CLI sessions) — never blind-kill (incident: 2026-04-24).

---

## 2. Workspace path encoding

**The contract:** opencode is a Windows-native binary. Every API call that
takes a workspace path expects **Windows-native** format
(`C:\Users\kevin\Workspace\foo`). Our app stores workspaces in this format
in `meta.workspace`.

**WSL-side translation:** when *Node code* (Next.js running under WSL)
needs to read files from the workspace, it must translate
`C:\Users\kevin\Workspace\foo` → `/mnt/c/Users/kevin/Workspace/foo`. The
helper lives in `lib/server/blackboard/planner.ts::toNodeReadablePath`.

**When each is correct:**
- Pass to opencode (`?directory=...` query, session `directory` field):
  Windows path, untranslated.
- `fs.readFile` / Node `path.resolve` from server code: WSL-translated.
- Workspace shown to the user in our UI: Windows path (matches what they
  see in Explorer / VSCode).

Forgetting to translate one direction is a silent failure mode. The
session won't error — it just won't read the file.

---

## 3. The 7 endpoints we call

| Verb · Path | What we use it for | Response shape | Quirks |
|---|---|---|---|
| `POST /session?directory=<path>` | Create a session in a workspace | `OpencodeSession` | Body: `{ title? }`. Omitting title = opencode mints a placeholder. |
| `GET /session?directory=<path>` | List per-workspace sessions | `OpencodeSession[]` | **Bare `GET /session` returns ONLY global sessions** (`projectID="global"`). Per-project sessions need `?directory=` to surface — see `memory/reference_opencode_session_scoping.md`. List order DRIFTS between polls — sort by id for stability. |
| `GET /session/{id}?directory=<path>` | Single-session lookup | `OpencodeSession` | Works for any session regardless of project scope. |
| `GET /session/{id}/message?directory=<path>` | Fetch all messages in a session | `OpencodeMessage[]` | Always returns the FULL list — no pagination, no since-cursor. We diff client-side via `knownIDs` Set. |
| `GET /session/{id}/diff?directory=<path>` | Aggregate file changes | `Array<{file, patch}>` | **`?messageID=` and `?hash=` params are ACCEPTED but IGNORED** — always returns the session-aggregate diff. Per-turn granularity lives in `patch` parts' `files` field only. See `memory/reference_opencode_diff_endpoint.md`. |
| `POST /session/{id}/abort?directory=<path>` | Cancel in-flight turn | 200 | Soft cancel — already-dispatched tool calls finish, but no further reasoning fires. Idempotent on idle sessions. |
| `POST /session/{id}/prompt_async?directory=<path>` | Send a prompt fire-and-forget | 200 / 204 | The danger zone — see §4. |
| `GET /agent?directory=<path>` | List available agents | `Agent[]` | Built-ins as of 2026-04-25: `build`, `compaction`, `explore`, `general`, `plan`, `summary`, `title`. Plus any from user's `opencode.json`. |
| `GET /event?directory=<path>` | SSE event stream | text/event-stream | Instance-scoped by directory. EventSource auto-reconnects; we use it for live message updates. |
| `GET /permission?directory=<path>` | Pending tool-permission requests | `OpencodePermissionRequest[]` | Only populated when user runs opencode with permission gating — our deployment runs allow-all (`memory/feedback_opencode_permissions.md`). |
| `POST /permission/{id}/reply?directory=<path>` | Reply to a permission request | 200 | Body shape per opencode SDK; we don't currently use this path. |

---

## 4. `prompt_async` — the silent-failure surface

`POST /session/{id}/prompt_async` is where most incidents have originated.
Its body shape:

```ts
{
  parts: [{ type: 'text', text: '...' }],
  agent?: string,         // OPTIONAL — see "agent silent-drop"
  model?: { providerID, modelID }, // NOT a bare string — see "model format"
}
```

**Returns 200 / 204 even when the prompt is silently dropped.** The HTTP
status lies; the truth is in whether a new user message + assistant turn
actually appears in `/session/{id}/message` afterwards. F1 silent-turn
watchdog (`lib/server/blackboard/coordinator.ts`) is our defense.

### 4a. The `agent` silent-drop trap

If the `agent` value is NOT in opencode's built-in list AND not in the
user's `opencode.json`, the POST returns 204 success but **never persists
the user message and never starts an assistant turn**. The session sits
at `msgs=N` forever; F1 declares `opencode-frozen` after ~240s.

Built-in agents: `build`, `compaction`, `explore`, `general`, `plan`,
`summary`, `title`.

**Default: don't pass `agent`.** Role display in our UI comes from
`roleNamesBySessionID(meta)`, not opencode's metadata. The prototype
uses agent-less dispatch as the safe default after commit `0c79175`
(`docs/POSTMORTEMS/2026-04-25-agent-name-silent-drop.md`).

**Exception:** `'orchestrator'` works despite not being in the
built-in list. Reason unknown — kept the orch-worker kickoff with that
param because it works empirically.

**Diagnostic probe:** if a session shows `msgs` not growing after a POST
that returned 200/204, send the same prompt without `agent`. If it
lands, the agent name was the culprit.

### 4b. Model format

`model` is **NOT a bare string**. It's an object: `{ providerID, modelID }`.
We parse `<provider>/<modelID>` (canonical catalog format) into the
object shape inside `postSessionMessageServer` before posting. No
splitting? Defaults `providerID = 'opencode'` with the bare string as
modelID.

Examples:
- `ollama/glm-5.1:cloud` → `{ providerID: 'ollama', modelID: 'glm-5.1:cloud' }`
- `opencode-go/glm-5.1` → `{ providerID: 'opencode-go', modelID: 'glm-5.1' }`
- `claude-sonnet-4-6` → `{ providerID: 'opencode', modelID: 'claude-sonnet-4-6' }`

If `agent` AND `model` are both set, **opencode's agent-config takes
precedence** — the named agent's configured model overrides the direct
model hint.

### 4c. When `prompt_async` succeeds but the turn never completes

Different failure mode from 4a. The user message DOES persist. The
assistant turn STARTS (you see `info.time.created`). But `info.time.completed`
stays null forever; no parts arrive.

**Most common cause:** Zen rate-limit (HTTP 429 `FreeUsageLimitError`).
opencode logs the 429 server-side but doesn't propagate it through the
session API. See `memory/reference_zen_rate_limit.md` and our liveness
watchdog at `lib/server/zen-rate-limit-probe.ts`. Diagnosed by
`grep 'statusCode":429' <opencode-log-file>`.

**Other causes observed:** session-context overflow (we preflight at
85% of model limit per `IMPLEMENTATION_PLAN 6.10`), tool-loop on a
structurally-broken tool call (gemma4 fixating on `edit` with bad
oldString — F1 watchdog detects and aborts).

---

## 5. Session lifecycle

**Creation:** `POST /session?directory=<path>` mints a session. opencode
assigns `projectID` based on whether `<path>` is a registered project
(repo with `.git`) or a free path (= `projectID: "global"`).

**Abort:** `POST /session/{id}/abort` cancels any in-flight turn. Idle
sessions are no-ops. Aborting twice is safe.

**No deletion API we use.** Sessions persist in opencode's data dir
indefinitely. Our app retains every session it created — see
`memory/project_retention_policy.md`. The user can blow away the data
dir manually if they want a clean slate.

**Cascade:** unknown. We don't currently delete sessions, so we haven't
verified whether deleting a session cascades to its messages or just
orphans them.

**Context window fills:** we preflight prompts at 85% of the model's
context limit (refuse) / 60% (warn) using the latest assistant turn's
`tokens.input` as the baseline projection. Without preflight, opencode
will accept the prompt and the model will reject downstream — wasted
spend.

---

## 6. Zombie assistant turns

Assistant turns can hang in a state where:
- `info.time.created` is set
- `info.time.completed` is null
- `info.error` is unset (no signaled failure)
- No new parts arrive

This is NOT an error opencode propagates. From the API's perspective
the turn is "in flight" indefinitely. See
`memory/reference_opencode_zombie_messages.md`.

**Our defenses:**
- F1 watchdog (`waitForSessionIdle`) — declares `silent` after silence
  threshold + aborts the session.
- F4 reachability probe — when silence ≥ PROBE_AFTER_MS, probes ollama's
  `/api/ps`. If unreachable, return `provider-unavailable` immediately
  rather than waiting for silent threshold.
- Liveness watchdog at the run level — flags zombies for the UI banner.

---

## 7. Things that change at runtime

- **Session list order** drifts between bare-`GET /session` polls. Always
  sort by immutable `id` for stable rendering
  (`memory/reference_opencode_session_order.md`).
- **`/agent` list** — does the available agent list change? We assume
  it's stable for the lifetime of an opencode process. Built-ins definitely
  are; user-defined agents only change if the user edits `opencode.json`
  while opencode is running. **Untested.**
- **`/event` SSE backpressure** — we haven't observed dropped events at
  prototype scale (~10 sessions × 3 turns/min). Behavior under heavy load
  is unknown.

---

## 8. What to do when wiring a new opencode call site

1. **Read this file first.** Specifically §3 (endpoint catalog) for the
   verb/path/quirks.
2. **Don't pass `agent` unless validated.** Use `roleNamesBySessionID`
   for our display, not opencode's `agent` field. If you NEED agent,
   verify it's in the built-in list OR loaded into the session's
   project's `opencode.json`.
3. **Use `{ providerID, modelID }` object shape for `model`.** A bare
   string is silently mis-routed to `providerID: 'opencode'`.
4. **Respect workspace path encoding.** Windows-native to opencode,
   WSL-translated to Node's `fs`.
5. **Treat HTTP 200/204 as "request accepted," not "work done."**
   Verify the side effect (new message in `/message`, ticker outcome,
   etc.) before declaring success.
6. **Wrap in F1-style watchdog when waiting for assistant turns.**
   `waitForSessionIdle` is the canonical helper; reuse it instead of
   rolling your own poll loop.
7. **Log enough state to file a postmortem if it surprises you.** Our
   tradition: dev-server.log + opencode log timestamp + dev message
   IDs + run ID + the exact request body that misbehaved.

---

## 9. What we explicitly DO NOT support

These limitations are intentional, not gaps. See `WHAT_THIS_PROJECT_IS_NOT.md`
for the full list; the opencode-specific ones:

- **Multi-tenant opencode instances.** We assume one opencode daemon per
  user, talking to one Anthropic / Zen account. Run-isolation is by
  workspace path, not by tenant.
- **Per-turn diff retrieval.** opencode's diff endpoint accepts
  `?messageID=` but ignores it. We list affected files per turn (from
  `patch` parts) and show the session-aggregate diff with a caveat.
- **Synchronous prompt** (`POST /session/{id}/prompt`). We use
  `prompt_async` exclusively because it lets the route handler return
  immediately and the SSE event stream surface progress. Sync prompt
  would force a long-held HTTP connection.
- **Permission gating.** Our user runs opencode with allow-all permissions
  (`memory/feedback_opencode_permissions.md`). The `/permission` endpoint
  exists and is plumbed in `lib/opencode/live.ts`, but our coordinators
  don't use it.

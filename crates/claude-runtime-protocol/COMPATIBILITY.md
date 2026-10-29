# Protocol compatibility

This is the contract between a sidecar (the server in `apps/claude-sidecar`) and a host that drives it
through `proto/verdandi/claude/runtime/v1/runtime.proto`. The numbers and strings it talks about live in
one file, [`capabilities.json`](capabilities.json), next to this one. The sidecar builds its handshake from
it, this crate exports constants generated from it, and a test on each side fails if either drifts from it.
A host should import those constants rather than copy a string.

## The rule

- **Major** is a breaking change: a field's meaning, tag or type, an RPC, an enum number, a behaviour a
  correct host relied on. A sidecar answers a handshake only for its own major, so a major bump locks out
  every host built for the old one. Nothing short of that justifies one.
- **Minor** is an additive change: a field, a message, an enum value, an RPC, a capability. Every additive
  change to the wire raises `protocol_minor` by one and adds a row to the `minors` ledger in
  `capabilities.json` (the next section of this file says how a test holds that).
- **A capability per feature.** A host decides what it may use by the capability strings the handshake
  lists, never by the minor or by the sidecar's version. **An absent capability means absent**: a host
  must not assume a feature from a number. `protocol_minor` and `sidecar_version` are for display and
  diagnostics.
- **Advertise only what is wired.** A capability is added in the same change that makes the sidecar honour
  it. The handshake's list keeps the order `capabilities.json` gives it, with the `executable_*` pair last.

### The major-3 baseline

Every sidecar that answers protocol major 3 guarantees these eleven capabilities, with no further check. A
host that has confirmed `protocol_major == 3` may use them without looking for their strings (Eitri 0.2.0
sends `setting_sources` and `tool_policy` unchecked, and is correct to):

`handshake`, `create_session`, `send_turn`, `watch_session_events`, `interrupt_turn`, `resolve_permission`,
`close_session`, `resume_session`, `fork_session`, `setting_sources`, `tool_policy`.

They are the rows marked `yes` below; `capabilities.json` flags them `"baseline": true`. The baseline can
only grow with a major bump, because a sidecar that stopped honouring one would break a host that never
checked. The three permission modes (`interactive`, `verdandi_rules`, `bypass`) are baseline too.

## Capabilities

`Since` is the protocol minor that introduced it (0 is the state at protocol 3's introduction). `Advertised`
says when a sidecar lists it. The order is the handshake's order.

| Capability | Since | Baseline | Advertised | What it is |
|---|---|---|---|---|
| `handshake` | 0 | yes | always | The `Handshake` RPC |
| `create_session` | 0 | yes | always | The `CreateSession` RPC |
| `send_turn` | 0 | yes | always | The `SendTurn` RPC |
| `watch_session_events` | 0 | yes | always | The `WatchSessionEvents` RPC: a replayable, gapless event stream |
| `interrupt_turn` | 0 | yes | always | The `InterruptTurn` RPC |
| `resolve_permission` | 0 | yes | always | The `ResolvePermission` RPC |
| `close_session` | 0 | yes | always | The `CloseSession` RPC |
| `resume_session` | 0 | yes | always | `CreateSession.resume_provider_session_id`, answered by a `ResumeOutcome` event. A parameter of `CreateSession`, so it cannot be discovered from the service definition |
| `fork_session` | 0 | yes | always | `CreateSession.fork`, meaningful with a resume |
| `setting_sources` | 0 | yes | always | `ClaudeHostPolicy.setting_sources`: which settings tiers the CLI loads (user, project, local) |
| `tool_policy` | 0 | yes | always | `ClaudeHostPolicy.tool_policy`: a deny list, an allow list, or `unrestricted` (the last added at minor 2) |
| `session_model` | 3 | no | always | `CreateSession.model` |
| `session_effort` | 3 | no | always | `CreateSession.effort` |
| `system_prompt` | 4 | no | always | `CreateSession.system_prompt`: a full replacement of the CLI's prompt |
| `output_format` | 5 | no | always | `CreateSession.output_format`: schema-validated output |
| `structured_output` | 6 | no | always | `TurnCompleted.structured_output_json`, `result_subtype`, `terminal_reason`, `api_error_status`, `errors` |
| `turn_usage` | 7 | no | always | `TurnCompleted.usage`, summed from the SDK's model usage; cumulative per session |
| `account_identity` | 8 | no | always | `SessionReady.account_identity` (the kernel's account probe; a completion-shaped session holds its first turn until it answers) and the handshake's `account_binding`, `account_name`, `account_config_dir` |
| `init_fingerprint` | 9 | no | always | `SessionReady.init_fingerprint` (the tools and MCP servers actually offered) and the zero-tools invariant behind it: an explicit empty allow list closes the session with `TOOL_POLICY_VIOLATION` on any other reported tool |
| `tool_allow_list` | 10 | no | always | A non-empty explicit allow list is checked against `system/init` too, and the WebFetch private-address deny rules apply when the list names WebFetch |
| `egress_restricted` | 10 | no | only when startup proved this process cannot reach loopback (`VERDANDI_CLAUDE_SIDECAR_EGRESS=restricted`) | The process claims restricted network egress, with evidence. A systemd `--user` unit with `IPAddressDeny=` proves nothing, so the claim is never taken from configuration alone |
| `set_permission_mode` | 11 | no | always | The `SetPermissionMode` RPC and the `PermissionModeChanged` event. A host may decline to call it |
| `text_delta_message_id` | 11 | no | always | `TextDelta.message_id`, `ThinkingDelta.message_id`: a change of id is a new message |
| `provider_permission_prompts` | 12 | no | always | `ClaudeHostPolicy.provider_permission_prompts`: the CLI's own asks are routed to the host as `PermissionRequested` with `origin = PROVIDER_PROMPT` |
| `init_check` | 13 | no | always | `ToolAllowList.init_check`: `VERIFY` (also what `UNSPECIFIED` and an older sidecar do) closes the session over a tool-set mismatch; `REPORT_ONLY` reports `SessionReady.init_fingerprint` and never closes. Under `VERIFY` the check detects and terminates after the turn started; it does not prevent a tool call under bypass |
| `await_account_identity` | 13 | no | always | `CreateSessionRequest.await_account_identity`: `CreateSession` returns once the account probe settles (bounded by its 20 s deadline) with the result in `CreateSessionResponse.account_identity`, before any turn exists. OK always names a live session; a session that ended during the wait fails the call with `PROVIDER_UNAVAILABLE`. It proves the login, not which credential is billed |
| `egress_probe` | 13 | no | always | `HandshakeResponse.egress_probe`: whether the startup loopback probe ran and what it found (`NOT_RUN`, `LOOPBACK_BLOCKED`) |
| `structured_output_tools` | 13 | no | always | `HandshakeResponse.structured_output_tools`: the tool names the CLI adds to a session with an output format, as measured |
| `effective_tool_report` | 13 | no | always | `SessionReady.effective_disallowed_tools` and `.effective_tools`: `Options.disallowedTools` and `Options.tools` exactly as the session handed them to the SDK |
| `cli_auto_mode` | 14 | no | always | `ClaudeHostPolicy.cli_permission_mode`: `AUTO` runs the CLI in its own `auto` mode under the PreToolUse gate, which stays installed (matcher `*`) and still asks the host about every call; `SessionReady.permission_mode` then reads `auto`. Only with `INTERACTIVE`; with `VERDANDI_RULES`, `BYPASS` or `permission_mode_switchable` it is `INVALID_CONFIGURATION`, and an `AUTO` session refuses `SetPermissionMode`. `UNSPECIFIED` is exactly the behaviour before the field |
| `permission_defer` | 14 | no | always | `ResolvePermissionRequest.defer`: the host makes no decision and the CLI's own permission handling decides the call (the auto classifier under `AUTO`, the CLI's normal ask under `default`), including the session's loaded settings tiers (their allow and deny rules, their own hooks: a user-tier `allow: ["Bash"]` lets a deferred Bash run without the classifier); the request resolves `PERMISSION_OUTCOME_DEFERRED`. Only on a session created with `permission_mode_switchable = false` (every `AUTO` session is): a host that can switch a session to `BYPASS` cannot also leave decisions to the CLI's mode, because a switch sent before or after the deferral can reach the CLI first and run the call under `bypassPermissions`, past the conservative floor. `INVALID_CONFIGURATION`, the request staying pending, on a switchable session, with `allow = true`, on a `PROVIDER_PROMPT`, and when the session's gate would not ask about that call. Only an explicit defer means "no decision": a hook timeout, abort, interrupt, close or provider death still denies |
| `permission_denied_events` | 14 | no | always | The `PermissionDenied` event: the CLI refused a call on its own (its classifier, a settings deny rule, its mode), with the CLI's strings verbatim. Only on a session that stated `cli_permission_mode` (`DEFAULT` or `AUTO`); any other session gets the `ProviderNotice` `system`/`permission_denied` it always got. Informational: the CLI already refused the call |
| `cli_compatibility_report` | 15 | no | always | `HandshakeResponse.cli_compatibility` (the installed CLI) and `.bundled_cli_compatibility` (the SDK's own CLI, only in a build that can run it): a verdict `SUPPORTED`, `UNTESTED`, `REFUSED` or `UNKNOWN`, with the version, the supported range and the tested versions. By default (`VERDANDI_CLAUDE_SIDECAR_CLI_GATE` unset or `refuse`) a `REFUSED` or `UNKNOWN` CLI stops the process before it binds, as it always did, so a handshake reports only `SUPPORTED` or `UNTESTED`. A process started with `CLI_GATE=report` binds anyway, reports the verdict, and refuses `CreateSession` with `UNSUPPORTED_CLI_VERSION` on a `REFUSED` or `UNKNOWN` CLI unless the request sets `ClaudeHostPolicy.accept_unsupported_cli`, which a default-mode process ignores |
| `gated_cli_mode_default` | 15 | no | always | The statement in the next section, made checkable: an `INTERACTIVE` or `VERDANDI_RULES` session starts the CLI in its `default` mode. It adds no field and no option |
| `effective_claude_config_dir` | 16 | no | always | `HandshakeResponse.effective_claude_config_dir`: the configuration directory the `claude` CLI really reads for this process's sessions (settings, credentials, projects, transcripts). A pinned account's directory (`$HOME/.claude` for an account at the CLI's default location); unpinned, the sidecar's own `CLAUDE_CONFIG_DIR` when set (empty if it is relative), else `$HOME/.claude`, else empty; empty means "not known". A path computed from the environment: nothing under it is read, so no credential can reach the handshake. `account_config_dir` keeps its meaning (empty unless pinned) |
| `startup_report_file` | 17 | no | always | The machine-readable startup report (the section below): with `VERDANDI_CLAUDE_SIDECAR_REPORT_FILE` set the process writes one JSON line per startup outcome, and `ErrorDetail.reason` names which rule refused a request. The capability is for the record: the handshake happens after startup, so a host that wants the report sets the variable whether or not it has seen the string. A sidecar without it ignores the variable and leaves `reason` empty |
| `effective_session_report` | 18 | no | always | `SessionReady.effective_setting_sources`, `.effective_configuration` and `.cli_permission_mode_kind`: the setting tiers the session handed the SDK (`Options.settingSources`, after the canonical order and the default taken from `configuration`; empty means no tier, and is a fact only from a sidecar that has this capability, since a repeated field cannot tell empty from absent), the configuration profile with `UNSPECIFIED` resolved, and the CLI's own permission mode as an enum (`DEFAULT`, `ACCEPT_EDITS`, `PLAN`, `BYPASS_PERMISSIONS`, `DONT_ASK`, `AUTO`, `UNKNOWN`; `UNSPECIFIED` when `system/init` named none). `permission_mode` keeps the CLI's verbatim string and stays the authority: a mode this sidecar does not know is `UNKNOWN` here and unchanged there. Reporting only; what the CLI then found on disk is not read |
| `extra_mcp_servers` | 19 | no | always | `VERDANDI_CLAUDE_EXTRA_MCP_SERVERS`, a JSON object set by the process that starts the sidecar, maps 1 to 8 server names to stdio MCP servers that are merged into every session's `mcpServers`, NATIVE and ISOLATED alike. Advertised because this build implements the merge, whether or not the variable is set; unset means every session's options are what they were before. A malformed value refuses to start (`ENV_INVALID`). An ISOLATED session that has extra servers also turns the claude.ai connectors off for itself (`disableClaudeAiConnectors`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`); a NATIVE one keeps them. A session with a verified allow list (`init_check` `VERIFY`) permits the declared servers' tools (a tool whose server part, the text between `mcp__` and the first `__` after it, is a declared name exactly, never a prefix match) and closes with `TOOL_POLICY_VIOLATION` unless `system/init` reports exactly the declared servers, each `connected` with at least one tool (an unreadable `mcp_servers` is not an empty one; like the tool check this detects and terminates, it does not prevent); a session without an allow list is not checked. With the variable unset, a verified session (explicit allow list) that reports any MCP server, even a failed or pending one, or an unreadable `mcp_servers`, now fails: that is fail-closed, and no frozen client is affected (Eitri 0.2.0 sends `unrestricted`; the b3aa188 control plane runs ISOLATED with strictMcpConfig). No wire change |
| `extra_mcp_servers_http` | 19 | no | always | The same variable also takes `type: "http"` servers: `url` (http or https, no credentials), `headers_from_env` (header name to the name of a variable in the sidecar's own environment, which must be set and non-empty at startup), `alwaysLoad`, `timeout`. A header value never appears in the variable or in any argv: the session's config carries `${VAR}`, which the CLI expands from the environment it inherits. The value stays in the sidecar's environment, so a session on that sidecar that can run commands can read it: such a server belongs on a sidecar whose sessions cannot |
| `steer_turn` | 20 | no | only when the host CLI's version, as probed at startup, is at least 2.1.252 (`STEER_MIN_CLI_VERSION`, the oldest CLI known to report message lifecycles) | The `SteerTurn` RPC and the `UserMessageDelivered` / `UserMessageDropped` events: a user message added to the running turn with priority `next`. The CLI folds it into that turn after the current tool batch, or runs it as a turn of its own right after: whenever a steered message's fate is still open at the running turn's `TurnCompleted`, the sidecar sends `TurnStarted` for a new turn at once (so `SendTurn` is refused until it ends) and later `UserMessageDelivered{into_running_turn: false}` in it. Exactly one of the two events per accepted message. An interrupt does not withdraw steered messages, as Esc does not in the CLI's own terminal: the ones the CLI still holds run as that new turn, so a host shows them as still to run Each session additionally refuses with `STEER_UNAVAILABLE` (`cli_lifecycle_not_reported`) until its CLI lists `msg_lifecycle_v1` in a `system/init`, which also covers the first moments of a session's first turn; a host holds the message for `SendTurn` then. `NO_ACTIVE_TURN` when idle, `TURN_MISMATCH` for a stale `expected_turn_id` |
| `list_commands` | 20 | no | always | The `CommandsUpdated` event: the session's whole slash-command list (`name`, `description`, `argument_hint`, `aliases`), sent once shortly after the session starts (usually before any turn, but with no fixed place among turn events) and again on every `system/commands_changed`; a host replaces its list each time, and the last one is the newest. A watch that would not otherwise see the newest list (started `FROM_NOW`, or its replay lost it) makes the sidecar send it again as a new event with the next sequence, to every watcher. When the CLI never answers, a `ProviderNotice` `verdandi_commands` says so instead |
| `system_prompt_preset` | 21 | no | always | `CreateSession.system_prompt_preset`: explicit Claude Code preset with optional verbatim append; absent prompt fields use the Agent SDK's minimal prompt |
| `cli_turns` | 22 | no | always | Turns Claude Code starts by itself are ordinary turns: `TurnStarted` with `origin = CLI` and a `cause`, every frame of theirs labelled with their id, closed by their result (`TurnCompleted.origin_kind`, `num_turns`) or, without one, by the CLI going idle (`terminal_reason` `no_result`). `SendTurn` is refused `TURN_ALREADY_ACTIVE` while one runs; a cycle the CLI runs ahead of an accepted `SendTurn`'s message is `CliCycleStarted` (see "Turns the CLI starts") |
| `human_origin` | 22 | no | always | `SendTurnRequest.typed_by_person` and `SteerTurnRequest.typed_by_person` stamp the pushed SDK message with `origin: {kind: 'human'}` exactly when true, including slash commands; `client_composed` is never set. False or absent preserves the unstamped message. Only true joins the command payload hash, preserving old hashes while detecting origin changes |
| `subagent_frames` | 22 | no | always | Child tool calls/results and text/thinking deltas carry `parent_tool_use_id` and the turn in which that parent Agent/Task call started, even after it ended. Child frames never open or close a turn; unknown parents use the open turn or an empty turn id |
| `background_tasks` | 22 | no | always | Full background task roster (REPLACE) and STARTED/PROGRESS/UPDATED/NOTIFIED edges; kind joined to the launching tool; an empty roster when each query starts or restarts; task prompts are never forwarded |
| `workflow_progress` | 22 | no | always | `local_workflow` tasks have WORKFLOW kind and bounded `workflow_name`; PAUSED status; PROGRESS edges carry defensively parsed phases and agents, excluding scripts, previews and logs. The undeclared CLI field is re-recorded at every CLI bump |
| `task_control` | 22 | no | always | The `StopTask` RPC stops one background task, a workflow's whole run included, idempotent per `command_id`; `TASK_NOT_FOUND` for a task the session never saw, success without reaching the CLI for one that has ended. `ClaudeHostPolicy.per_task_stop` declares the per-task stop to the CLI (`perTaskStopAffordance`), so an interrupt spares background agents and workflows (see "Task control and output") |
| `task_output` | 22 | no | only when the process can open a file without following a symbolic link and knows its own uid (Node's `O_NOFOLLOW` and `process.getuid`) | The `GetTaskOutput` RPC: the last 8192 bytes of a shell's or a Monitor's output, `total_bytes` and `truncated`, read from the file the CLI named for that task; the request takes no path. `TASK_OUTPUT_UNAVAILABLE` when there is none it may read, always for a workflow or a local agent (see "Task control and output") |
| `session_notices` | 22 | no | always | Allowlisted CLI notices with typed scalars and the CLI's own optional text; content is bounded to 2000 characters. Unknown peer hold states remain payload-less notices (see "Session notices and reset") |
| `conversation_reset` | 22 | no | always | `ConversationReset.new_conversation_id` and optional `trigger`; the provider session id the conversation goes on under (the one resume needs) is the next `SessionReady`'s, which can differ from `new_conversation_id` |
| `structured_questions_v1` | 22 | no | always | The model's `AskUserQuestion` as a typed interaction: `CreateSession.client_interactions.questions` offers the tool, `InteractionRequested`/`InteractionResolved` carry each question and its end, `ResolveInteraction` answers it and `GetInteractionState` lists the open ones (see "Structured questions") |
| `executable_host_cli` | 1 | no | always | This build can spawn the `claude` installed on the machine (`ClaudeHostPolicy.executable = HOST_CLI`) |
| `executable_sdk_bundled` | 1 | no | only in a build that can run the SDK's own CLI (a checkout; not the packaged single-file build) | `ClaudeHostPolicy.executable = SDK_BUNDLED` |

What each minor added, by date, is the `minors` array in `capabilities.json`. Minors 1 to 12 were assigned
on 2026-09-30, one per additive feature in the order it landed, from the history; until then the handshake
reported a literal 0 for all of them. Protocol 3.12 is the wire Eitri 0.2.0 was built against.

## Protocol 3.22

Minor 22 adds the wire for the turns Claude Code starts by itself, its background tasks and workflows,
subagent frames, the notices its terminal shows, `/clear`, the human-origin stamp, and structured
questions. It adds the wire before any of the behaviour: each of its ten capabilities (`cli_turns`,
`human_origin`, `subagent_frames`, `background_tasks`, `workflow_progress`, `task_control`, `task_output`,
`session_notices`, `conversation_reset`, `structured_questions_v1`) is advertised only by the change that
makes it work, and a capability that is not listed does not exist, whatever the minor says. All ten are
listed now, `task_output` only where its row says.

**Wire.**

| Where | What | Number | Capability |
|---|---|---|---|
| `TurnStarted` | `origin` (`TurnOrigin`: `CLIENT`, `FOLLOW_UP`, `CLI`), `cause` (`TurnCause`, `TurnCauseKind`: `TASK`, `SCHEDULED`, `PEER`, `OTHER`, `UNKNOWN`) | 2, 3 | `cli_turns` |
| `TurnCompleted` | optional `origin_kind`, optional `num_turns` | 12, 13 | `cli_turns` |
| `SendTurnRequest` | optional `client_message_id`, echoed by `UserMessageDelivered` / `UserMessageDropped` | 4 | `cli_turns` |
| `SendTurnRequest`, `SteerTurnRequest` | `typed_by_person` | 5, 6 | `human_origin` |
| `ToolCallStarted`, `ToolCallCompleted`; `TextDelta`, `ThinkingDelta` | optional `parent_tool_use_id` | 5; 4 | `subagent_frames` |
| `ClaudeHostPolicy` | `per_task_stop` | 12 | `task_control` |
| `CreateSessionRequest` | `client_interactions` (`ClientInteractions { questions = 1; reserved 2; }`) | 11 | `structured_questions_v1` |
| `SessionEvent` arms | `TurnCauseUpdated`, `CliCycleStarted` | 30, 31 | `cli_turns` |
| `SessionEvent` arms | `BackgroundTasksChanged`, `TaskEvent` (`BackgroundTask`, `TaskKind`, `TaskStatus` with all eight of the CLI's statuses, `TaskEdge`, `TaskUsage`) | 32, 33 | `background_tasks` |
| `TaskEvent` | `workflow_progress` (`WorkflowProgress`, `WorkflowPhase`, `WorkflowAgent`) | 14 | `workflow_progress` |
| `SessionEvent` arm | `SessionNotice` (`SessionNoticeKind`, `NoticeLevel`, `RateLimitStatus`, `PeerHoldState`) | 34 | `session_notices` |
| `SessionEvent` arm | `ConversationReset` | 35 | `conversation_reset` |
| `SessionEvent` arms | `InteractionRequested`, `InteractionResolved` (`InteractionKind`, `QuestionSet`, `Question`, `QuestionOption`, `ShownAnswer`, `InteractionOutcome`) | 40, 41 | `structured_questions_v1` |
| RPC | `StopTask`, idempotent per `command_id` | -- | `task_control` |
| RPC | `GetTaskOutput`, a read with no `command_id`; `output` is bytes, since the tail may start inside a UTF-8 sequence | -- | `task_output` |
| RPCs | `ResolveInteraction` (`QuestionAnswers`, `QuestionAnswer`, `QuestionDecline`, `QuestionDeclineKind`), `GetInteractionState` | -- | `structured_questions_v1` |
| `ErrorCode` | `TASK_NOT_FOUND`, `TASK_OUTPUT_UNAVAILABLE` | 16, 17 | -- |
| `ErrorCode` | `INTERACTION_NOT_FOUND`, `INTERACTION_ANSWER_REFUSED` | 30, 31 | -- |

**Numbers.** `SessionEvent` 27 to 29 are written `reserved`: 27 and 28 are not used (the interaction arms
were placed at 40 and 41 instead), and 29 is held for a later planning-state event. `CreateSessionRequest`
12 and `HandshakeResponse` 20 are written `reserved` for a later attachments minor, `ClientInteractions` 2
for plan approval, `InteractionKind` 2 likewise, and `ResolveInteractionRequest` 12 to 19 for plan-approval
results. `SessionEvent` 36 to 39 are free for later turn events and 42 to 49 for later interactions;
`ErrorCode` 18 to 29 for later task and turn errors.

**Before a capability is listed.** A request field that asks for a feature a sidecar does not have is
refused with `INVALID_CONFIGURATION`, never accepted and ignored: a 3.22 sidecar that did not yet list
`task_control` refused `per_task_stop = true` (`per_task_stop_unsupported`) and answered `StopTask` and
`GetTaskOutput` with gRPC `UNIMPLEMENTED` and an `ErrorDetail` whose `reason` is `not_wired`. Nothing is
recorded under the command id of a refused `SendTurn` or `SteerTurn`. `client_message_id` is accepted, and
takes part in the command id's payload only when it is present. A sidecar older than 3.22 answers every
new RPC `UNIMPLEMENTED` without a reason, and ignores `client_interactions` and `per_task_stop` (unknown
fields). A host sends none of these fields and calls none of these RPCs
unless the handshake lists the capability.

### Subagent frames (`subagent_frames`)

`ToolCallStarted`, `ToolCallCompleted`, `TextDelta` and `ThinkingDelta` carry the frame's
`parent_tool_use_id` when it is a string. Such frames never open or close a turn and their content is
forwarded even with no turn open; they do not become notices for want of a turn. Their `turn_id` is
the turn recorded when the parent `Agent` or `Task` call's `ToolCallStarted` was emitted. Nested agents
record that same attribution for their own calls. Parent calls remain recorded after completion and
after their turn ends, until session end, with at most 1024 entries and the oldest evicted first.
For an unknown or evicted parent (including a workflow's agent), `turn_id` is the open turn's id,
or an empty string when none is open. Main-thread frames have no parent field.

The SDK's `forwardSubagentText` option stays unset (default false): subagent text and thinking are not
requested, matching the terminal. Any such content the CLI does send retains its parent and turn.
Parent ids are bounded to 128 characters at the sidecar, on a character boundary with `…` appended
within that limit; attribution uses the original id in the kernel.

### Background tasks (`background_tasks`)

`BackgroundTasksChanged` replaces the live roster; `TaskEvent` carries STARTED, PROGRESS, UPDATED
and NOTIFIED edges. A query starts with an empty roster, including one created to resume after a
previous process ended; later `system/init` frames do not clear it. The roster is sent when membership
changes and is not sent again to a later watcher (unlike `CommandsUpdated`): a watch that starts
`FROM_NOW`, or whose replay no longer holds the newest roster, has none until membership next changes. A
host that needs the roster watches from available history and resumes `AFTER_SEQUENCE`, treating
`EVENT_GAP` as losing it. Ordering between level and edges
is unspecified. UPDATED reads status, end time, error and backgrounding from `patch`; NOTIFIED with
`running` status is an event rather than an ending. Optional `run_id` and `reason` are type-checked;
malformed fields or entries are dropped with one counted diagnostic per frame.

The kernel joins `task_started.tool_use_id` to its launching tool: Monitor is MONITOR,
Bash/PowerShell are SHELL, otherwise `local_agent` is LOCAL_AGENT, `local_bash` is SHELL and other
raw types are OTHER. A roster entry preceding its start is provisionally SHELL. TASK turn causes
use the same join. The kernel retains up to 256 task identities and 1024 launching tool names,
evicting the oldest entries first; wire bounds apply at the sidecar without changing join ids.
The `workflow_progress` capability adds WORKFLOW for `local_workflow` and `workflow_name`.

Only selected fields are forwarded: task prompts, workflow previews/logs and transcript file
contents are excluded. The existing character and roster bounds apply at encoding. `output_file`
is metadata on the wire; `GetTaskOutput` reads a shell's output (see "Task control and output").

### Task control and output (`task_control`, `task_output`)

**Stop.** `StopTask{session_id, command_id, task_id}` sends the CLI's `stop_task` for one task the
session knows: one it saw start, or one the latest `BackgroundTasksChanged` lists. A workflow's id stops
the whole run; the CLI has no per-agent stop. The CLI then reports the end itself (`TaskEvent` NOTIFIED
with status `STOPPED`). A task whose last run reported `completed`, `failed`, `stopped` or `killed`, or
whose session has ended, answers success without reaching the CLI, as does a stop the CLI refuses because
the task ended on the way. An unknown id is `TASK_NOT_FOUND`. The same request again under the same
`command_id` answers success without reaching the CLI; another `task_id` under it is
`IDEMPOTENCY_CONFLICT`; a refused request records nothing, so it may be sent again under the same id. A
duplicate that arrives while the first is still waiting on the CLI waits for it rather than sending a
second stop.

**`per_task_stop`.** True sets the SDK option `perTaskStopAffordance`: the host promises a per-task
stop, and an interrupt then ends only the turn, leaving background agents and workflows running, as the
CLI's own terminal does. What those tasks wait on is left running too: a permission request or question
from a subagent that is a listed, running background agent, or an agent a running workflow's progress
named, stays open through the interrupt and ends when the host answers it, the CLI withdraws it
(`expired`, as when the task is stopped) or the session closes. Every other pending request -- the main
thread's, a foreground agent's, an agent the sidecar cannot yet place in a running task -- ends
`CANCELLED_BY_INTERRUPT` / `INTERRUPTED` as before. False or absent leaves the option unset, and the
CLI's own rule stands: an interrupt kills background agents and workflows (recorded on CLI 2.1.311: in `c07b` the agent ends
`killed` and the background shell runs on to `completed`; in `c16w_stop.run2` the workflow ends `killed`).
A host sends it only when the handshake lists `task_control`.

**Output.** The SDK has no method for the CLI's `get_task_output`, so `GetTaskOutput{session_id,
task_id}` reads the file the CLI writes the task's output to, in the sidecar, beside the CLI that names
it; the host never opens a path a sidecar handed it, and the request takes none. A path is recorded only
for a SHELL or MONITOR task, from two sources: that task's `task_notification.output_file`, and the CLI's
launch template, "Command running in background with ID: <task_id>. Output is being written to:
<path>.", at the start of the result of the call the task started from (`task_started.tool_use_id`),
with the id in it equal to the task's. A template in any other result, and a local agent's or a
workflow's `output_file`, are ignored. A recorded path must be absolute, have no `..` component, and be
in the directory of the first path accepted in the session (the CLI's task directory; only a shell's or
a Monitor's path fixes it). The file is opened read-only with `O_NOFOLLOW` (and without blocking), and
`fstat` must show a regular file owned by the sidecar's uid. The answer is the bytes from
`max(0, size - 8192)`, `total_bytes = size` and `truncated = size > 8192`; `output` is bytes because the
tail may start inside a UTF-8 sequence. A WORKFLOW or LOCAL_AGENT task is `TASK_OUTPUT_UNAVAILABLE`
without looking for a path; so is a task with no accepted path or a file that fails a check. Refusals are
logged by the rule's name, never with the file's content. An unknown id is `TASK_NOT_FOUND`. A host
shows the bytes as plain text.

### Workflow progress (`workflow_progress`)

Only PROGRESS edges belonging to a known WORKFLOW task carry `workflow_progress`; a different
`run_id` cannot inherit the previous run's classification. An absent progress field leaves the
frame unchanged. `task_updated.patch.status = paused` encodes as PAUSED.

The undeclared CLI array is read as selected scalars, never copied wholesale. Recorded
`workflow_phase` / `workflow_agent` entries use camelCase (`phaseIndex`, `agentType`, `toolCalls`,
`durationMs`); the hand-built `phase` / `agent` fixtures use snake_case. Phase index and title,
and agent index, label, phase index and state are required. An absent phase kind encodes as an
empty string, as the recordings omit it. Optional agent fields remain absent. A wrong-typed
field drops its entire entry; the rest of the frame passes, with malformed entries counted in
the frame's single diagnostic. Indices and counts are nonnegative safe integers within their
wire range. No state or kind labels are invented.

The parser keeps at most 64 phases and 256 agents. The sidecar also enforces those limits and
bounds workflow names and all progress strings to 128 characters, except agent errors (500),
including an appended `…` on a character boundary when truncated. `prompt`, `promptPreview`,
`resultPreview`, `workflow_log` and transcript file content never enter task events. The
`c16w`, `c16w_stop.run2` recordings and the explicitly hand-built H-wf1 fixture exercise these
shapes. Every CLI bump must re-record H-wf1 before trusting this undeclared field again.

### Turns the CLI starts (`cli_turns`)

**What opens one.** With no turn open, the first main-thread frame that shows the CLI working opens a turn
with `origin = CLI`, ahead of that frame's own events: `system/status` `requesting`, a stream event, an
assistant message, a tool result, or a `command_lifecycle` `started` for a message no host sent (a scheduled
prompt). A frame with a parent tool call (a subagent's), a task event, `background_tasks_changed` and
`system/init` open nothing: the CLI sends `system/init` ahead of a coalesced notification that it answers
with an empty result, and a turn opened there would never close. `cause` is `TASK` with the newest task
notification since the last result (its task id, status and summary; the task's description and kind from
its `task_started`), else `UNKNOWN`. At the close, an `UNKNOWN` cause is refined by the result's
`origin.kind` (`task-notification` gives `TASK`, `coordinator` and `observer` give `OTHER`) through
`TurnCauseUpdated`, before `TurnCompleted`. `SendTurn` and the steer follow-up open `CLIENT` and
`FOLLOW_UP` turns.

**Which result closes which turn**, the first rule that matches:

1. An autonomous result (origin `task-notification`, `peer`, `coordinator`, `observer` or
   `observer-activity`, naming none of the open turn's own messages) with `num_turns` 0 that is not an
   error is a placeholder for a coalesced notification: it closes nothing and sends nothing.
2. An open `CLI` turn: any other result closes it.
3. A `CLIENT` or `FOLLOW_UP` turn whose message the CLI has not taken in yet, with a lifecycle frame for
   that message seen: a result that does not name it ended a cycle the CLI ran first and closes nothing.
4. The same, naming the message: closes the turn.
5. The message was taken in (`started`), or dropped while a cycle ran: closes the turn.
6. No lifecycle frame seen for the message (a CLI that reports none, a local slash command, a skipped
   frame): an autonomous result closes nothing.
7. The same, any other result: closes the turn. Every origin outside the five autonomous ones, absent and
   unknown ones included, is treated as the user's.
8. No turn open: the result is reported as a `CLI` turn, opened and closed at once.

No `TurnCompleted` names a turn nobody started. A message the CLI drops while no cycle runs ends its turn
at once, `COMPLETED` with no text. A turn that ends without a result (that drop, or the idle below) while a
steered message is still held opens the follow-up turn at once, as a result does, so a `SendTurn` is refused
until the held message has run or been dropped.

**Idle.** The sidecar starts every CLI with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, so the CLI reports
`session_state_changed`; the frames are consumed and never forwarded. Each result leaves one idle owed; an
owed idle is absorbed, and a transition into `running` clears the debt. An idle that is not owed ends the
open turn with `TurnCompleted{FAILED, terminal_reason: "no_result"}`, for a `CLIENT` or `FOLLOW_UP` turn
only once its message started or the CLI went `running` after the turn opened. A CLI that sends no state
frames leaves turns to their results.

**A cycle ahead of a sent message.** A `SendTurn` accepted while the CLI looked idle can find the CLI
answering something else first (a notification queued just before). The turn keeps its id. On a CLI that
reports message lifecycles, the first main-thread output while the message still waits sends
`CliCycleStarted{turn_id, cause}`, and that output is labelled with the turn; when the CLI takes the
message in (or a result names it, or rule 7 closes the turn with no lifecycle frame for the message),
`UserMessageDelivered{client_message_id, turn_id, into_running_turn: true}` follows, before the
`TurnCompleted`, and a message the CLI drops gets `UserMessageDropped`. Both name the request's
`client_message_id` and are sent only when it was given. Without lifecycle reports there is no
`CliCycleStarted`, and only rules 6 and 7 keep the cycle's result from closing the turn. A `SendTurn` on an
idle CLI that takes the message in first never sees `CliCycleStarted`.

**Old clients.** An old request builds the same SDK options as before with one exception: `options.env` is
always set, to the process environment (or the caller's base environment) plus
`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, overwriting any value the environment had. The SDK's own default
for an unset `env` is that same copy of the process environment, so the CLI an old client starts differs by
that one variable, whose frames the sidecar consumes and never forwards. An old client sees `TurnStarted`
and `TurnCompleted` for the CLI's own turns (their new fields are unknown to it) and its own turns as before,
with one change: a turn the CLI started by itself is open, so a `SendTurn` while it runs is refused
`TURN_ALREADY_ACTIVE`. Before 3.22 the message was accepted. The window opens when the CLI wakes up after
the client's own `TurnCompleted` (a background task it started finishes, a scheduled wake-up fires) and
closes at that turn's `TurnCompleted`. The refusal records nothing under the `command_id`, so a client
waits for that `TurnCompleted` and sends the same request again; Eitri 0.2.0 shows it as a failed send,
and the frozen b3aa188 pipeline client fails the call. The frozen-client suite has no scenario with a turn
the CLI starts. The in-repo control plane waits and resends (`sendFollowUp`).

The sidecar does not filter events by client: the handshake cannot tell a client that reads the 3.22 arms
from one that does not, so an old client receives every one the session produces, as unknown arms it drops:
`TurnCauseUpdated` (30), `CliCycleStarted` (31), `BackgroundTasksChanged` (32, an empty one at the start
of every query's history), `TaskEvent` (33), `SessionNotice` (34) and `ConversationReset` (35). What it loses:

- 30 and 31: why the CLI ran a turn of its own, and where the CLI's own cycle ends inside a turn the client
  sent. The turns themselves are the `TurnStarted`/`TurnCompleted` pairs it reads; a cycle's output carries
  the id of the client's open turn.
- 32 and 33: before these arms the same task frames reached it as `ProviderNotice`s, which Eitri 0.2.0 prints
  as diagnostic lines and keeps no state from; it loses those lines.
- 34: before this arm the retry, rate-limit, fallback, refusal, compaction, informational, notification
  and peer-hold frames reached it as `ProviderNotice`s carrying only the frame's type and subtype; it loses
  those lines, and with them the news that a call is being retried, that the account is near or at its
  rate limit, that the model was switched or that the conversation was summarised. A rate limit, refusal
  or exhausted retry that stops the work still ends the turn with a `TurnCompleted` whose `is_error`,
  `stop_reason`, `terminal_reason`, `api_error_status` and `errors` it reads.
- 35: the diagnostic line for `/clear`. The provider session id the conversation goes on under arrives in
  the `SessionReady` of the CLI's next `system/init`, which it reads.

Nothing fail-closed (a denial, a kill, a downgrade, a refusal) is reported only in these arms: permissions
are decided by the sidecar and reach the client as `PermissionRequested`/`PermissionResolved`. The
frozen-client suite lists arms 30 to 35 in `ALLOWED_UNDECODABLE_EVENT_ARMS`, each with its reason; any
other arm an old client cannot decode fails it. `InteractionRequested` and `InteractionResolved` (40, 41)
reach only a session that asked for questions, which an old client cannot do.

### Structured questions (`structured_questions_v1`)

**Offer.** `CreateSession.client_interactions.questions = true` asks for the model's `AskUserQuestion`. It is
refused with `INVALID_CONFIGURATION` `client_interactions_needs_provider_prompts` unless the policy is
`INTERACTIVE` with `provider_permission_prompts`. On an opted-in session `AskUserQuestion` leaves the applied
deny list (a caller's own `tool_policy.deny` of it still wins; `EnterPlanMode` and `ExitPlanMode` stay
denied), the preview format is `markdown`, and `CLAUDE_CODE_QUESTION_EXTENDED`,
`CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS` and `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT` are removed from the
CLI's environment. A session that does not ask gets exactly the 3.21 tool set and options.

**A question is an interaction, never a permission.** The PreToolUse gate makes no decision for the call,
and no `PermissionRequested` exists for it. The CLI's own ask for it becomes one `InteractionRequested`
(`kind` `QUESTION`, `tool_use_id` the CLI's, a fresh single-use `interaction_id`) and exactly one later
`InteractionResolved`. Nothing that answers permissions settles a question (`ResolvePermission` on any id, a
switch to `bypass`, a host's approve-all), and the sidecar has no default, no timeout and no policy for
one: it ends only by `ResolveInteraction`, `InterruptTurn` (`INTERRUPTED`; under `per_task_stop` not a
running background task's, see "Task control and output"), `CloseSession`
(`SESSION_CLOSED`), the provider dying (`PROVIDER_FAILED`), or the CLI withdrawing it (`EXPIRED`). A
session that did not opt in never offers the tool; if the CLI asks anyway, the call is denied and no event
is sent.

**What the sidecar checks before showing one.** The input must be the baseline schema: `questions[]` of
`{question, header, options[{label, description, preview?}], multiSelect}`, an optional `metadata` (kept
as it is) and an optional `annotations` (replaced by the answer). A question set is refused whole, never
cut, when it has another key anywhere, `answers` already filled in, 1 to 4 questions or 2 to 4 options
exceeded, a repeated question text or a repeated label within a question, a `question` over 4000, a
`header` over 256, a `label` over 1000, a `description` over 4000 or a `preview` over 16384 UTF-16 code
units, more than 256 KiB of JSON (UTF-8) in the parsed set, or when four questions already wait on the
session. A refusal is `InteractionRequested` with `unsupported_reason` and no payload, then at once
`InteractionResolved` `HOST_REFUSED` with the same `reason`; the model is told "This client could not show
the question: <reason>. Ask in plain text instead." The reason is plain English the sidecar writes, cut to
2000 characters.

**ResolveInteraction.** Idempotent per `(session_id, command_id)` over everything but those two ids; a
different payload under a used id is `IDEMPOTENCY_CONFLICT`, and a replay returns the first outcome even
after the interaction is spent. An unknown, settled or other session's `interaction_id` is
`INTERACTION_NOT_FOUND`. A result that breaks a rule is `INTERACTION_ANSWER_REFUSED` with `ErrorDetail.reason`
naming it (see `ErrorDetail.reason`); the question keeps waiting and nothing is recorded under the command
id. The rules: question and option indexes in range and not repeated; a single-select question takes at most
one of an option and `other_text`; `notes` only on a single-select question with a preview on some option;
a serialized answer at most 32768, all of a set's together at most 32768, `notes` at most 8192 UTF-16 code
units; a decline is `CANCEL` or `CHAT`, and only `CHAT` carries `so_far`. An answer with no option and no
`other_text` (empty counts as none) leaves its question unanswered.

**What the model gets.** Answers: the CLI's own shape, `{...input, answers, annotations}` built from the
input the CLI sent. `answers` is keyed by question text and has the answered questions only: a single-select
answer is the option's label or the typed text; a multi-select answer is the picked labels in option order
and then the typed text, each item JSON-quoted when it contains `", "` or `"`, joined with `", "`.
`annotations` is always present; it has an entry, keyed by question text, only for an answered
single-select question with previews, holding the picked option's `preview` and the trimmed `notes`, each
only when not empty. `CANCEL`: the CLI's rejection text with `interrupt: true`, so the turn stops as it does
when the terminal's question is dismissed (`DECLINED`). `CHAT`: the CLI's "clarify these questions" text
listing every question with its answer so far or "(No answer provided)" and its notes; the turn goes on
(`CHAT_REQUESTED`). Both texts are Claude Code's, read from 2.1.302. `InteractionResolved.answers` holds the
`ShownAnswer`s exactly as sent (for `ANSWERED` and `CHAT_REQUESTED`).

**GetInteractionState.** The open questions of a session, as `InteractionRequested` messages, and the
event sequence they were read at (`through_sequence`). A question asked or settled after that sequence comes
in the stream with a higher sequence, so a client that buffers live events, takes the snapshot and applies
the events after `through_sequence`, deduplicating by `interaction_id`, holds the session's open set. A
question in neither is over; its outcome is read from the ring or, past it, unknown, never assumed
answered.

## Permission modes

The handshake's `permission_modes` is `interactive`, `verdandi_rules`, `bypass` (`PERMISSION_MODE_*` in the
Rust constants). They are the values `ClaudeHostPolicy.permissions` maps to; the set is baseline.

## The gated-mode invariant

An `INTERACTIVE` or `VERDANDI_RULES` session is started with `--permission-mode default`, and reports what the
CLI says in `SessionReady.permission_mode`. The capability `gated_cli_mode_default` says a sidecar keeps
this. It is not a product default and there is no option to change it: the explicit mode is what makes a gated
session gated, because without it the CLI would take its starting mode from `permissions.defaultMode` in the
project and local settings tiers, which are files in the repository under work. A project's own settings
therefore cannot move a gated session out of `default`.

The one host-side lever is stated, never inferred: `ClaudeHostPolicy.cli_permission_mode = AUTO` (capability
`cli_auto_mode`) starts an `INTERACTIVE` session in the CLI's `auto` mode, under the same gate. A session that
states nothing, or states `DEFAULT`, runs in `default`. A host that reads `SessionReady.permission_mode` and
sees anything less restrictive than what it asked for should stop (the sidecar's own check is that report).

## The CLI gate

The sidecar classifies the installed `claude` and the SDK's own, once, at startup (`SUPPORTED`, `UNTESTED`,
`REFUSED`, or `UNKNOWN` for a version that could not be read). Two modes, chosen by the operator through
`VERDANDI_CLAUDE_SIDECAR_CLI_GATE`, never by a client:

- **`refuse`** (unset, empty or `refuse`): a `REFUSED` or unreadable CLI stops the process before anything is
  bound, with the stderr texts a host matches. The wire never shows a refused verdict, and
  `accept_unsupported_cli` is ignored.
- **`report`**: the process binds and reports the verdict in the handshake. `CreateSession` is refused with
  `UNSUPPORTED_CLI_VERSION` for a session whose CLI (`executable`) is `REFUSED` or `UNKNOWN`, unless the request
  carries `accept_unsupported_cli = true`. `UNTESTED` and `SUPPORTED` need nothing. Any other value of the
  variable refuses to boot.

  For an `UNKNOWN` or `REFUSED` CLI, nothing the probed CLI printed reaches the wire in this mode: an `UNKNOWN`
  diagnostic says why the version could not be read with the CLI's own output replaced by
  `[CLI output omitted: N bytes]`, and a `REFUSED` version -- in `cli_compatibility.version`, in
  `actual_claude_code_version` and at every mention of it in the diagnostic -- is its leading
  `major.minor.patch`, or that marker when it has none -- the same forms the startup report uses. A `SUPPORTED`
  or `UNTESTED` version is reported in both fields as the first word the CLI printed on stdout, as in `refuse`
  mode, including any characters after its `major.minor.patch`. The process's stderr still shows the whole text.

The gate never tightens by default: the floor, the ceiling and the known-incompatible list are what they were,
and a version tested since (`2.1.283`) only stops being reported `UNTESTED`.

## The startup report

A host that spawns the sidecar learns how it went from the exit code, a stderr tail it may pattern-match
and a socket it may poll. None of those has a name that will not be reworded, so a host may ask for a fourth:
set `VERDANDI_CLAUDE_SIDECAR_REPORT_FILE` to an absolute path in a directory it has created, a fresh path per
spawn. The sidecar appends one JSON object per line, mode 0600:

```json
{"v":1,"kind":"ready"|"refused"|"diagnostic","code":"...","message":"...","details":{}}
```

- The stderr text is **unchanged in every case**. `message` is that text, with three differences: the output
  of the probed `claude` is never written (see below), a message is capped at 8 KiB with a `[truncated: N more
  bytes]` marker, and credential values are masked. A host that matches stderr keeps working, and one that
  reads the file gets the same words under a code that will not change.
- Every record carries `details.pid`, the sidecar's process id, so a file shared or reused across spawns can be
  told apart.
- With the variable unset or blank nothing is written and nothing is computed. A path that cannot be used
  (relative, a missing directory, a directory, a path whose last component is a symlink, anything that is not a
  regular file such as a FIFO or a device) or a write that fails or is short costs one stderr line,
  `claude-sidecar: cannot write the startup report to "<path>": ...`, and turns the report off; startup then
  goes on, or fails, exactly as it would have without the variable: the exit code and every other line are the
  same. Opening never blocks.
- **The CLI's own output is never written.** What a probed `claude` printed (its stderr after a failed probe,
  and the version word it printed) can carry whatever a launcher prints, a credential included. Where a message
  would embed it, `message` carries the sidecar's own sentence with the output replaced by `[CLI output omitted:
  N bytes]`, and a version that is not `major.minor.patch` is recorded as that marker in `details`; a version
  with a readable start is recorded as its leading `major.minor.patch`. Only the exit status and signal are in
  `details`. Stderr still shows the full text.
- No credential is otherwise written: only paths, versions, enums and the sidecar's own sentences, with the
  values of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` masked as `[redacted]`
  in every string value of a record.
- A record is written with one `write` of a whole line, so a reader that reads whole lines never sees half
  of one. The file is not truncated; a path reused across spawns holds both runs.

**`ready`** (code `READY`) is written once, after the socket accepts connections and the stop signals and the
stdin watch are in place, and not before: a host that reads it may connect at once instead of polling.
`details`: `socket` (the path), `pid`, `sidecar_version`, `protocol` (`{"major","minor"}`). A host that sees no
`ready` and no `refused` has learned nothing; it keeps its own timeout.

**`diagnostic`** `CLI_UNTESTED`: an installed or bundled `claude` inside the supported range that was never
tested; the process starts. `details`: `binary` (`host` or `sdk-bundled`), `version`.

**`diagnostic`** `CLI_LEFT_TO_HOST`: with `VERDANDI_CLAUDE_SIDECAR_CLI_GATE=report`, a `claude` that is `REFUSED`
or `UNKNOWN` did not stop the start; the process binds and refuses `CreateSession` on it unless the request
sets `accept_unsupported_cli` (see the CLI gate). One record per such binary, before `ready`. `details`:
`binary` (`host` or `sdk-bundled`), `verdict` (`refused` or `unknown`), `version` (as the handshake reports it:
empty for `unknown`).

**`refused`**: the process is about to exit 1 before binding anything. One record per start, the last line
written. `details` keys are listed where a code has them; a host must ignore keys it does not know.

| code | when | `details` |
|---|---|---|
| `SOCKET_ENV_MISSING` | `VERDANDI_CLAUDE_SIDECAR_SOCKET` is not set, or is set but empty (`message` is then the bind error the process prints) | `variable` |
| `SOCKET_PATH_TOO_LONG` | the socket path is longer than a unix socket address holds on this platform | `socket`, `bytes`, `limit` |
| `SOCKET_IN_USE` | another process is listening on the socket path | `socket` |
| `CLI_NOT_FOUND` | the `claude` to probe does not exist (`ENOENT`) | `cli_path`, `spawn_error_code` |
| `CLI_PROBE_FAILED` | the `claude` exists but would not say its version: it exited non-zero, was killed, or could not be started for another reason | `cli_path`, and whichever of `spawn_error_code`, `exit_status`, `signal` apply |
| `CLI_VERSION_UNPARSEABLE` | the version it printed is not `major.minor.patch` (the first refused binary names the code, as for `CLI_OUT_OF_RANGE`) | `binaries` |
| `CLI_OUT_OF_RANGE` | a version outside the supported range, on the known-incompatible list, or (with `VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION`) untested | `binaries`: a list of `{binary, version, reason}`, `reason` one of `out_of_range`, `known_incompatible`, `strict_untested`. When both the installed and the bundled CLI are refused, `code` is the first one's (the bundled one is listed first) and `binaries` lists all |
| `EGRESS_MODE_INVALID` | `VERDANDI_CLAUDE_SIDECAR_EGRESS` is neither `open` nor `restricted` | `variable` |
| `EGRESS_PROOF_FAILED` | `restricted` was asked for and loopback is reachable (or the proof could not be run) | `variable` |
| `ACCOUNT_INVALID_NAME` | `VERDANDI_CLAUDE_ACCOUNT` is not a single path-safe segment | `variable` |
| `ACCOUNT_NO_HOME` | a pinned account needs `HOME` and it is unset or not absolute | |
| `ACCOUNT_RELATIVE_OVERRIDE` | `VERDANDI_CLAUDE_CONFIG_DIR` or `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR` is not an absolute path | `variable` |
| `ACCOUNT_DEFAULT_CONFLICT` | an account at the CLI's default location combined with a directory that says otherwise, or with `VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR` | `variable` when one is named |
| `ACCOUNT_DIR_MISSING` | the pinned account's configuration directory does not exist | `account` |
| `ACCOUNT_NOT_LOGGED_IN` | the directory holds no credentials and `ANTHROPIC_API_KEY` is unset | `account` |
| `ACCOUNT_DEFAULT_LOCATION_SYMLINK` | at the default location, the directory, the credentials or `$HOME/.claude.json` is a symlink | `account` |
| `ACCOUNT_NO_RECORDED_IDENTITY` | at the default location, `$HOME/.claude.json` is missing, unreadable or records no `oauthAccount.emailAddress`. When it is not JSON, `message` names the parser's error (`SyntaxError`) but not its text, which quotes the file; stderr shows the text | `account` |
| `ENV_INVALID` | a `VERDANDI_CLAUDE_SIDECAR_*` variable holds a value its parser refuses: `PARENT_WATCH`, `RING_CAPACITY`, `FAULT_DROP_WATCH_AFTER`, `WRITE_QUEUE_STATS_MS`, `CLI_GATE`; or `VERDANDI_CLAUDE_EXTRA_MCP_SERVERS` is malformed, or names a header variable that is unset or empty (the message names both variables and never a value) | `variable` (the full name) |
| `STARTUP_FAILED` | anything else that escapes before the socket is bound (a socket directory that cannot be created, a bind that fails): the catch-all, so no exit before bind is unrepresentable | `error_name`, `error_code` when the error has them |

`VERDANDI_CLAUDE_SIDECAR_STRICT_CLI_VERSION` has no invalid value (anything but `1` or `true` is off), and
`VERDANDI_CLAUDE_SIDECAR_REPORT_FILE` is never a refusal; neither can produce `ENV_INVALID`.

### `ErrorDetail.reason`

`ErrorDetail.reason` (string, tag 3) names which rule refused a request, for `INVALID_CONFIGURATION`,
`STEER_UNAVAILABLE` and `INTERACTION_ANSWER_REFUSED`; it is empty
when the sidecar has no name for the refusal, and on a sidecar older than `startup_report_file`. The text in
`message` may be reworded; a reason may not. A host that meets one it does not know treats it as "some refusal
with this error code".

| reason | refused |
|---|---|
| `configuration_unknown` | a `configuration` value the proto does not declare (`UNSPECIFIED` is declared and means `NATIVE`) |
| `permissions_unknown` | a `permissions` value the proto does not declare (`UNSPECIFIED` means `INTERACTIVE`) |
| `persistence_unknown` | a `persistence` value the proto does not declare (`UNSPECIFIED` means `EPHEMERAL`) |
| `executable_unknown` | an `executable` value the proto does not declare (`UNSPECIFIED` means `HOST_CLI`) |
| `streaming_unknown` | a `streaming` value the proto does not declare (`UNSPECIFIED` means `COMPLETE`) |
| `executable_unavailable` | `executable: SDK_BUNDLED` on a build that cannot serve it |
| `setting_source_unknown` | a `setting_sources` member that is not a settings tier |
| `cli_permission_mode_unknown` | a `cli_permission_mode` value this sidecar does not know |
| `cli_auto_needs_interactive` | `cli_permission_mode = AUTO` outside an `INTERACTIVE` session |
| `cli_auto_with_switchable` | `cli_permission_mode = AUTO` with `permission_mode_switchable` |
| `init_check_unknown` | a `tool_policy.allow.init_check` value this sidecar does not know |
| `tool_policy_unrestricted_with_restriction` | `unrestricted` together with `deny` or `allow` |
| `tool_policy_empty_name` | an empty tool name in `deny` or `allow.tools` |
| `tool_policy_deny_allow_overlap` | a tool named in both `deny` and `allow.tools` |
| `tool_policy_allow_provider_prompt_tool` | `allow.tools` names a tool `provider_permission_prompts` removes |
| `effort_unknown` | an `effort` that is not a defined level |
| `system_prompt_conflict` | both `system_prompt` and `system_prompt_preset` are present, including an empty preset object; checked before blank values |
| `system_prompt_blank` | a `system_prompt` that is present and blank; omit both prompt fields for the SDK minimal prompt, or use `system_prompt_preset` for Claude Code's system prompt |
| `system_prompt_append_blank` | `system_prompt_preset.append` is present and blank; omit append for the unmodified preset |
| `output_schema_not_json` | `output_format.json_schema_json` is not JSON |
| `output_schema_not_object` | `output_format.json_schema_json` is JSON but not an object |
| `resume_id_empty` | `resume_provider_session_id` present and empty |
| `fork_without_resume` | `fork` without a session to resume |
| `defer_not_allowed` | `ResolvePermission.defer` where the session or the request cannot be deferred |
| `contradictory_answer` | `ResolvePermission.defer` together with `allow = true` |
| `permission_mode_unspecified` | `SetPermissionMode` with no target mode, or one this sidecar does not know |
| `permission_mode_refused` | `SetPermissionMode` the session cannot make |
| `permission_mode_provider_refused` | `SetPermissionMode` the CLI rejected |
| `replay_cursor_missing` | `AFTER_SEQUENCE` without `after_sequence` |
| `replay_cursor_unexpected` | `after_sequence` with a start that takes none |
| `replay_cursor_in_future` | an `after_sequence` beyond anything the session emitted |
| `replay_start_unrecognized` | a `WatchSessionEvents` start that is unset or unknown |
| `steer_client_message_id_missing` | `SteerTurn` without a `client_message_id` |
| `steer_expected_turn_id_missing` | `SteerTurn` without an `expected_turn_id` |
| `steer_text_empty` | `SteerTurn` whose `text` is empty or only whitespace |
| `steer_client_message_id_reused` | `SteerTurn` with a `client_message_id` already accepted on the session |
| `cli_lifecycle_not_reported` | (`STEER_UNAVAILABLE`) `SteerTurn` on a session whose CLI has not listed `msg_lifecycle_v1` in a `system/init` |
| `first_turn_held` | (`STEER_UNAVAILABLE`) `SteerTurn` while the session's first turn is held for its account identity |
| `client_interactions_needs_provider_prompts` | `client_interactions.questions = true` on a session that is not `INTERACTIVE` with `provider_permission_prompts` |
| `unknown_question_index` | (`INTERACTION_ANSWER_REFUSED`) an answer for a question the set does not have |
| `duplicate_question_index` | (`INTERACTION_ANSWER_REFUSED`) two answers for one question |
| `unknown_option_index` | (`INTERACTION_ANSWER_REFUSED`) an option the question does not have |
| `duplicate_option_index` | (`INTERACTION_ANSWER_REFUSED`) one option picked twice |
| `single_select_takes_one` | (`INTERACTION_ANSWER_REFUSED`) more than one of an option and `other_text` on a single-select question |
| `notes_not_allowed` | (`INTERACTION_ANSWER_REFUSED`) `notes` on a question that is not single-select with previews |
| `answer_too_long` | (`INTERACTION_ANSWER_REFUSED`) one serialized answer over 32768 UTF-16 code units |
| `answers_too_long` | (`INTERACTION_ANSWER_REFUSED`) a set's serialized answers together over 32768 UTF-16 code units |
| `notes_too_long` | (`INTERACTION_ANSWER_REFUSED`) `notes` over 8192 UTF-16 code units |
| `kind_mismatch` | (`INTERACTION_ANSWER_REFUSED`) no result, a decline that is neither `CANCEL` nor `CHAT`, or a `CANCEL` carrying answers |

## Identifying a sidecar

| Handshake field | Meaning | A host may |
|---|---|---|
| `protocol_major` | The contract's major | Refuse a sidecar whose major it was not built for |
| `protocol_minor` | How many additive revisions of this major the sidecar carries | Display it; never gate on it |
| `sidecar_version` | The sidecar's own semantic version (`apps/claude-sidecar/package.json`), also the first word after the name in `--version` | Display it, pin a release by it |
| `capabilities` | What this sidecar can do, in `capabilities.json` order | Decide feature by feature |

A host older than a minor keeps working as long as it ignores the fields, capabilities, enum values and
event arms it does not know; Eitri 0.2.0 does (an unknown enum value decodes as the unspecified one, an
unknown `ErrorCode` keeps its message, an unknown event arm is dropped). **Safety information therefore
never exists only in a new event**: anything that must fail closed is enforced on the sidecar side, or
carried by a field an older host already reads.

## Conventions that are easy to misread

- **An empty string means absent**, for every plain `string` field (ids, `detail`, paths, the account
  fields when unpinned, `SessionReady.permission_mode` from a sidecar older than that field). Do not read
  the emptiness as a fault or as an all-clear. Only a field declared `optional` has real presence, and
  there a present-but-empty value is distinct (and usually refused). The contract does not switch fields
  to `optional` after the fact, because that changes every generated API.
- **A watch stream can end with `EVENT_GAP` after delivering events**, not only refuse a cursor at
  the start. A watcher that stops reading its stream is ended once the live messages it has been
  holding since earlier pump ticks reach the replay buffer's capacity (the n of `event_buffer_policy`
  `bounded-<n>`; the replay it started with and the current tick's events are not counted, so up to
  that plus one tick's burst plus the replay may be queued): everything before the error was
  delivered, and the meaning is the code's usual one, "reconnect with your cursor" -- the last
  `sequence` received, with `REPLAY_START_AFTER_SEQUENCE`. Only a reconnect that is itself refused with
  `EVENT_GAP` means the history is gone. The session is not ended by this, and neither are its other
  watchers; but if it ends on its own before the reconnect (including in the very tick that ended the
  watcher), the reconnect gets `SESSION_NOT_FOUND`. No field or capability marks this; a host that reconnects on a failed watch already
  handles it.
- **`SessionReady.session_id` is the provider's (Claude's) session id**, the same value as
  `SessionReady.provider_session_id`, not the sidecar's. The sidecar's own session id is
  `SessionEvent.session_id` on the envelope, and is the id every RPC takes. A host matching a session
  matches on the envelope.

## Notices

`ProviderNotice` is informational: a `kind` and an optional `subtype`, never a payload. The kinds the
sidecar's own code emits:

- `verdandi_policy` (subtype `bypass_default_deny_applied`): a bypass session that stated no tool
  restriction was given the conservative deny list.
- `verdandi_commands` (subtype `unavailable` or `unreadable`): the session's slash-command list could not
  be read when it started (the SDK's `supportedCommands()` failed, or answered with something that is not a
  list), so no `CommandsUpdated` came then; a later `system/commands_changed` still sends one.
- `system` (subtype: the SDK's own `system` message subtype, any but `init`, which becomes `SessionReady`,
  `session_state_changed`, which the sidecar consumes, the allowlisted notice subtypes below, and `permission_denied` on a session that stated
  `ClaudeHostPolicy.cli_permission_mode`, which becomes `PermissionDenied`).
- `assistant_content_block` (subtype: the SDK's content-block type that has no dedicated event).

Any other SDK message type the sidecar does not translate is passed on as a notice whose `kind` is that
type's name and whose subtype is absent. A host must treat the kind space as open.

## Session notices and reset

`SessionNotice` maps `system/api_retry` (attempt, max retries, delay, optional error status and
error kind), `rate_limit_event` (status, reset time, utilization), `system/model_refusal_fallback`
and the defensively read `system/model_fallback` (original/fallback model, scope, content),
`system/model_refusal_no_fallback` (warning, original model, content), `system/status` only when
compacting, `system/compact_boundary` (pre/post tokens and trigger), `system/informational`
(level and content), and `system/notification` (text as content). Missing levels default to NOTICE;
missing fallback scope defaults to session. No display text is composed. API retries have no content.
`resetsAt` below 10^11 is seconds and is multiplied by 1000; larger values are milliseconds.
C13b did not emit a rate limit frame behind the harness's custom base URL, so hand-built frames
cover both units. `peer_message_hold`, also accepted as a system subtype, maps held, released and
dropped to PEER_HOLD with peer name and state; unknown states stay payload-less notices.
All other system subtypes stay payload-less, including status values other than compacting.

`conversation_reset` becomes `ConversationReset`, never a provider notice for a valid id.
Only its new conversation id and optional string trigger are forwarded, never
`retracted_message_uuids`. The next init remains authoritative for the provider session id: a
client that follows the cleared conversation (to resume it, or to find its history) takes the id from
the next `SessionReady`, not from `new_conversation_id`. A mismatch with the reset id is logged (C12
records such a mismatch: the reset names one id and the following inits another). C12's reset frame
carries `trigger: "clear"`. Malformed optional scalars are dropped with one counted
diagnostic per frame. These events do not change turn, gate or lease state.

## What guards this

- `apps/claude-sidecar/tests/compat/` (`run.sh`): a client generated from the frozen proto Eitri 0.2.0 was
  built against drives the sidecar and asserts what that host relies on. It must stay green, unchanged,
  through every change described here.
- `apps/claude-sidecar/tests/protocolSource.test.ts`, `protocolMinorLedger.test.ts`,
  `protocolDocs.test.ts` and this crate's `tests/protocol_constants.rs`: the one-source rule, the ledger
  below, and this file's own tables.

Minors 13 to 22 are unreleased: none of their ledger entries carries a `released` mark or a
`wire_fingerprint`. So the only wire frozen by test today is 3.12's, the proto the breaking-change check
compares against. What a client built against a later minor relies on (Eitri's main branch sends 3.14's
`cli_permission_mode` and `defer`; its `release/v0.3` branch also sends 3.21's `system_prompt_preset`,
field 10, when the `system_prompt_preset` capability is offered, until that branch is merged forward
into main) is held only by that check's "additions only" rule and by review, not pinned tag by tag,
until a release marks its minor and records the fingerprint (below).

### Changing the protocol

1. Edit `runtime.proto` additively. The breaking-change check fails a removal, renumbering or retyping.
2. Raise `protocol.minor` in `capabilities.json` by one and add a `minors` entry with the date, a
   summary, and `wire_additions`: the additions the proto check lists, verbatim (it prints them when it
   fails). Every addition since the frozen proto must be recorded under some minor above the frozen one,
   and the ledger must list every minor up to the current one.
   **A released minor is frozen.** The minor is raised per release that changes the wire, so unreleased
   development may add several fields under one new minor. When a release is cut, its ledger entry gets
   `"released": "<tag>"` and `"wire_fingerprint": "<sha256>"` (`npm run proto:fingerprint -w
   @verdandi/claude-sidecar` prints it; the step is in the release procedure in
   `apps/claude-sidecar/README.md`). The fingerprint hashes what the proto means (messages, tags, types,
   labels, enums, reservations, rpcs), not its comments or formatting. While that entry is the current
   minor, the live proto must keep that fingerprint, so a wire change after a release has to start a new
   minor (a new entry, `protocol.minor` raised) rather than be added to the released entry's
   `wire_additions`. No git or network is needed, so the check holds in the public export too.
   Every release marks its current minor this way, whether or not that minor changed the wire; an unmarked
   minor is not frozen. What the check does not do: it guards against an accidental wire change, not a
   deliberate edit of the ledger (deleting a `released` mark, or rewriting a fingerprint). The release tag is
   the independent record of what shipped, and a diff of the ledger shows such an edit to a reviewer. The
   fingerprint covers what binary protobuf decoding depends on; it ignores field options such as `packed`
   (proto3 parsers accept repeated scalars packed or not) and `json_name` (this protocol has no JSON
   transport).
3. Add a capability row for the feature when it has one, since that minor, in the same change that wires
   it. Keep `executable_*` last. Add its row to the table above.
4. Regenerate the Go bindings and run the control plane's tests where this checkout has them.
5. Run the compat suite, the sidecar's `npm test`, and `cargo test --locked` in this crate.

## Releases and tags

The sidecar is released under its own semantic version: a release that raises `protocol.minor` raises the
sidecar's minor at least, a fix that changes neither raises its patch. The protocol major is independent of
the sidecar's major. A host pins a release by its tag, not by a commit. The procedure is in
`apps/claude-sidecar/README.md`.

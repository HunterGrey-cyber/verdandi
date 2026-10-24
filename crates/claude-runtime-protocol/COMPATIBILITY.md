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
| `executable_host_cli` | 1 | no | always | This build can spawn the `claude` installed on the machine (`ClaudeHostPolicy.executable = HOST_CLI`) |
| `executable_sdk_bundled` | 1 | no | only in a build that can run the SDK's own CLI (a checkout; not the packaged single-file build) | `ClaudeHostPolicy.executable = SDK_BUNDLED` |

What each minor added, by date, is the `minors` array in `capabilities.json`. Minors 1 to 12 were assigned
on 2026-09-30, one per additive feature in the order it landed, from the history; until then the handshake
reported a literal 0 for all of them. Protocol 3.12 is the wire Eitri 0.2.0 was built against.

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

`ErrorDetail.reason` (string, tag 3) names which rule refused a request, for `INVALID_CONFIGURATION` and
`STEER_UNAVAILABLE`; it is empty
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
| `system_prompt_blank` | a `system_prompt` that is present and blank |
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
  and `permission_denied` on a session that stated `ClaudeHostPolicy.cli_permission_mode`, which becomes
  `PermissionDenied`).
- `assistant` (subtype `no_turn_in_progress`): an assistant message arrived with no turn open.
- `assistant_content_block` (subtype: the SDK's content-block type that has no dedicated event).

Any other SDK message type the sidecar does not translate is passed on as a notice whose `kind` is that
type's name and whose subtype is absent. A host must treat the kind space as open.

## What guards this

- `apps/claude-sidecar/tests/compat/` (`run.sh`): a client generated from the frozen proto Eitri 0.2.0 was
  built against drives the sidecar and asserts what that host relies on. It must stay green, unchanged,
  through every change described here.
- `apps/claude-sidecar/tests/protocolSource.test.ts`, `protocolMinorLedger.test.ts`,
  `protocolDocs.test.ts` and this crate's `tests/protocol_constants.rs`: the one-source rule, the ledger
  below, and this file's own tables.

Minors 13 to 20 are unreleased: none of their ledger entries carries a `released` mark or a
`wire_fingerprint`. So the only wire frozen by test today is 3.12's, the proto the breaking-change check
compares against. What a client built against a later minor relies on (Eitri's main branch sends 3.14's
`cli_permission_mode` and `defer`) is held only by that check's "additions only" rule and by review, not
pinned tag by tag, until a release marks its minor and records the fingerprint (below).

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

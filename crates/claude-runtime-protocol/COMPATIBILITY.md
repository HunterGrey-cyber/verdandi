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
| `executable_host_cli` | 1 | no | always | This build can spawn the `claude` installed on the machine (`ClaudeHostPolicy.executable = HOST_CLI`) |
| `executable_sdk_bundled` | 1 | no | only in a build that can run the SDK's own CLI (a checkout; not the packaged single-file build) | `ClaudeHostPolicy.executable = SDK_BUNDLED` |

What each minor added, by date, is the `minors` array in `capabilities.json`. Minors 1 to 12 were assigned
on 2026-09-30, one per additive feature in the order it landed, from the history; until then the handshake
reported a literal 0 for all of them. Protocol 3.12 is the wire Eitri 0.2.0 was built against.

## Permission modes

The handshake's `permission_modes` is `interactive`, `verdandi_rules`, `bypass` (`PERMISSION_MODE_*` in the
Rust constants). They are the values `ClaudeHostPolicy.permissions` maps to; the set is baseline.

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
- **`SessionReady.session_id` is the provider's (Claude's) session id**, the same value as
  `SessionReady.provider_session_id`, not the sidecar's. The sidecar's own session id is
  `SessionEvent.session_id` on the envelope, and is the id every RPC takes. A host matching a session
  matches on the envelope.

## Notices

`ProviderNotice` is informational: a `kind` and an optional `subtype`, never a payload. The kinds the
sidecar's own code emits:

- `verdandi_policy` (subtype `bypass_default_deny_applied`): a bypass session that stated no tool
  restriction was given the conservative deny list.
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

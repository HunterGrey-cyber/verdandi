# CLI stream replays

The R1 and R2 batches hold the layer-a harness recordings from 2026-10-28 (CLI
2.1.311, SDK 0.3.252, Verdandi revision
`16137374fe8717d86b263e76227dc240d7d98a08`): c01, c01c, c02b, c03_bg, c03_fg,
c04a, c04b, c05, c05w, c07b, c15a, c15b, c16, c16w, c16w_stop.run2 and c17 from
R1; c04d, c09, c10, c12, c13a, c13b, c14 and c18 from R2. They ran against the
harness's scripted model. No CLI or network model is used by these tests.

Each `<name>[.<variant>].messages.json` is `{ "manifest": {...}, "lines": [...] }`.
`<name>` is the staged run's path under the staging root with `/` replaced by `.`
(`c16w_stop/run2` becomes `c16w_stop.run2`), and `<variant>` is the import's
`--variant` (none for R1 and R2, `core` for R3). The manifest holds the staged
scenario and run, CLI and SDK versions, Verdandi revision, environment variable
names, the variant and whether the recording is stamped. Each line is
`{ "i": <tap arrival index>, "from": "host" | "cli", "message": <wire object> }`;
when the tap numbered each direction on its own, `i` is the merged position. When
the staging manifest has no explicit `stamped`, all host user messages must carry
a UUID for the recording to be treated as stamped. An unstamped recording only
replays through `withoutLifecycle`.

`<name>[.<variant>].control.json` exists only for a run with AskUserQuestion
traffic. It holds the `initialize` request, the AskUserQuestion control
exchanges, the first scrubbed model request's tool result per tool-use id, and
the count of dropped control lines. Other control traffic is excluded from
replay. Host interrupt and stop-task requests remain in the message stream.
Transcript files and workflow logs are never imported. Workflow prompts and
previews remain only in the private input fixtures, so later tests can detect
accidental forwarding.

Import from a scrubbed staging tree:

```sh
node packages/claude-runtime/tests/replay/import.mjs \
  --from /path/to/staging/r1 --scan /path/to/eitri/publish/scan.sh
```

Optional flags: `--variant <name>`, `--only c01,c16w_stop.run2` (a fixture name, or a scenario to take all its runs; runs not named are not read), `--out <directory>`.
The importer recursively finds run manifests (including `c16w_stop/run2`), refuses
unlisted files and unsanitized home paths, sorts by the tap's shared arrival
index, and falls back to monotonic time for indices local to each direction. It
runs the supplied Eitri publication scanner over the output and fails if it fails.

To replace a fixture, rerun that import for the scenario from a new harness gate,
review all three output files and the manifest revision, then rerun the replay
and order tests. Review changes to `gaps.json` individually: delete fixed gaps;
new gaps require investigation. Tests never rewrite the ledger. The ledger has a
separate entry for the recorded and lifecycle-free variants. `c04a.c04c` removes
the overlapping prompt result's UUID echo to exercise the identity fallback.

`$RUN` becomes one fresh absolute temporary directory for each replay and is
removed afterwards; `$USER`, `$HOST`, `$KEY` remain literal. Recorded host UUIDs
are mapped to the UUIDs actually pushed by the kernel in all later CLI frames.
The fake records every pushed message, preserves steer priority and counts
stop-task calls refused because the replayed session never saw the task.

`handbuilt/` contains synthetic shapes for the notice frames (every
`informational` level, `notification`, `model_refusal_no_fallback`, `api_retry`,
rate limits, compaction), reset, a peer wake and `peer_message_hold` in every state
including an unknown one, `model_refusal_fallback` with scope session, local and
absent, a scheduled fire, workflow progress, a background-task level that precedes
its `task_started`, a stamped send whose CLI reports no lifecycle, and the
partial/interleaved streaming cases. Each file's manifest has `"handbuilt": true`
and a `source` naming the `sdk.d.ts` 0.3.252 line or the recording the frame
derives from, or saying that the spec alone defines it. They are not harness
recordings. The recorded `c04d` replaced the planned hand-built fire before a
queued prompt. A scenario whose fixture is missing prints `fixture missing` and
skips unless `VERDANDI_REPLAY_REQUIRE_ALL=1`.

A host message that arrives while a turn runs, one the CLI started by itself
included, is steered into that turn, as a host that sees the turn does (a send
would be refused). The replay of a lifecycle-free variant cannot steer, so there
such a message is held back (counted); with no turn running it is an ordinary
send.

After building, run:

```sh
node --test --test-timeout=60000 \
  packages/claude-runtime/dist/tests/cliTurnsReplay.test.js \
  packages/claude-runtime/dist/tests/recordedOrder.test.js
```

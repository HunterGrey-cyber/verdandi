/**
 * One-at-a-time mutations of the frozen proto, as TEXT, each with what the checker must say about it.
 * Shared by protoBreaking.test.ts (the checker must agree) and by whoever wants to ask a second tool
 * the same questions: every entry is a small, self-contained edit, so `buf breaking` can be run over
 * the same set (it agreed with all of them when this file was written; see that test's header).
 */

export function once(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0) {
    throw new Error(`the mutation target is not in the frozen proto: ${JSON.stringify(from)}`);
  }
  if (text.indexOf(from, at + 1) !== -1) {
    throw new Error(`the mutation target is not unique: ${JSON.stringify(from)}`);
  }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

export type BreakingMutation = { name: string; mutate: (text: string) => string; reported: RegExp };
export type HarmlessMutation = { name: string; mutate: (text: string) => string; added: RegExp | undefined };

export const BREAKING: BreakingMutation[] = [
  { name: 'a field is renamed', mutate: (t) => once(t, '  string account_name = 13;', '  string account_label = 13;'), reported: /field 13 was renamed from account_name to account_label/ },
  { name: 'a field is renumbered', mutate: (t) => once(t, '  string account_name = 13;', '  string account_name = 113;'), reported: /field 13 \(account_name\) was removed or renumbered/ },
  { name: 'a field is removed', mutate: (t) => once(t, '  string event_buffer_policy = 11;\n', ''), reported: /field 11 \(event_buffer_policy\) was removed/ },
  { name: 'a scalar changes type', mutate: (t) => once(t, '  uint32 protocol_minor = 2;', '  uint64 protocol_minor = 2;'), reported: /protocol_minor: type changed from uint32 to uint64/ },
  { name: 'a scalar changes wire type', mutate: (t) => once(t, '  uint64 sequence = 2;', '  string sequence = 2;'), reported: /sequence: type changed/ },
  { name: 'a message field changes its message type', mutate: (t) => once(t, '  ClaudeHostPolicy policy = 2;', '  ToolPolicy policy = 2;'), reported: /policy: type changed from \.verdandi\.claude\.runtime\.v1\.ClaudeHostPolicy to \.verdandi\.claude\.runtime\.v1\.ToolPolicy/ },
  { name: 'a repeated field becomes singular', mutate: (t) => once(t, '  repeated string capabilities = 7;', '  string capabilities = 7;'), reported: /capabilities: cardinality changed from repeated to optional/ },
  { name: 'an optional field loses its presence', mutate: (t) => once(t, '  optional string model = 5;', '  string model = 5;'), reported: /model: presence changed/ },
  { name: 'a plain field gains presence', mutate: (t) => once(t, '  string text = 3;\n}\n\nmessage SendTurnResponse', '  optional string text = 3;\n}\n\nmessage SendTurnResponse'), reported: /text: presence changed/ },
  { name: 'a oneof arm moves out of its oneof', mutate: (t) => once(once(t, '    ResumeOutcome resume_outcome = 21;\n', ''), '  oneof event {', '  ResumeOutcome resume_outcome = 21;\n\n  oneof event {'), reported: /resume_outcome: moved from oneof event to oneof \(none\)/ },
  { name: 'an enum value changes its number', mutate: (t) => once(t, 'PERMISSION_MODE_BYPASS = 3;', 'PERMISSION_MODE_BYPASS = 30;'), reported: /PermissionMode: value 3 \(PERMISSION_MODE_BYPASS\) was removed or renumbered/ },
  { name: 'an enum value is removed', mutate: (t) => once(t, '  ERROR_CODE_DEADLINE_EXCEEDED = 13;\n', ''), reported: /ErrorCode: value 13 \(ERROR_CODE_DEADLINE_EXCEEDED\) was removed/ },
  { name: 'an enum value is renamed', mutate: (t) => once(t, 'ERROR_CODE_EVENT_GAP = 9;', 'ERROR_CODE_EVENT_HOLE = 9;'), reported: /ErrorCode: value 9 was renamed from ERROR_CODE_EVENT_GAP to ERROR_CODE_EVENT_HOLE/ },
  { name: 'a reservation is dropped', mutate: (t) => once(t, '  reserved 2;\n', ''), reported: /WatchSessionEventsRequest: reserved tags 2 are no longer reserved/ },
  { name: 'a reserved tag is reused', mutate: (t) => once(t, '  reserved 2;\n', '  uint64 old_cursor = 2;\n'), reported: /reserved|reuses tag 2/ },
  { name: 'an rpc is removed', mutate: (t) => once(t, '  rpc Handshake(HandshakeRequest) returns (HandshakeResponse);\n', ''), reported: /RuntimeService\.Handshake: rpc was removed/ },
  { name: 'an rpc changes its request type', mutate: (t) => once(t, 'rpc SendTurn(SendTurnRequest)', 'rpc SendTurn(InterruptTurnRequest)'), reported: /RuntimeService\.SendTurn: signature changed/ },
  { name: 'an rpc stops streaming', mutate: (t) => once(t, 'returns (stream SessionEvent)', 'returns (SessionEvent)'), reported: /WatchSessionEvents: streaming changed/ },
  { name: 'a message is removed', mutate: (t) => once(t, 'message ErrorDetail {', 'message ErrorDetailRenamed {'), reported: /message verdandi\.claude\.runtime\.v1\.ErrorDetail was removed/ },
  { name: 'an enum is removed', mutate: (t) => once(t, 'enum StreamingMode {', 'enum StreamingModeRenamed {').replace('StreamingMode streaming = 5;', 'StreamingModeRenamed streaming = 5;'), reported: /enum verdandi\.claude\.runtime\.v1\.StreamingMode was removed/ },
  { name: 'the package changes', mutate: (t) => once(t, 'package verdandi.claude.runtime.v1;', 'package verdandi.claude.runtime.v2;'), reported: /package changed/ },
];

export const HARMLESS: HarmlessMutation[] = [
  { name: 'a field is added', mutate: (t) => once(t, 'message HandshakeRequest {\n  uint32 client_protocol_major = 1;\n}', 'message HandshakeRequest {\n  uint32 client_protocol_major = 1;\n  string brand_new = 99;\n}'), added: /HandshakeRequest: new field optional string brand_new = 99/ },
  { name: 'an enum value is added', mutate: (t) => once(t, '  ERROR_CODE_DEADLINE_EXCEEDED = 13;\n', '  ERROR_CODE_DEADLINE_EXCEEDED = 13;\n  ERROR_CODE_FUTURE = 14;\n'), added: /ErrorCode: new value ERROR_CODE_FUTURE = 14/ },
  { name: 'a message is added', mutate: (t) => `${t}\nmessage Extra {\n  string x = 1;\n}\n`, added: /new message verdandi\.claude\.runtime\.v1\.Extra/ },
  { name: 'an enum is added', mutate: (t) => `${t}\nenum Extra {\n  EXTRA_UNSPECIFIED = 0;\n}\n`, added: /new enum verdandi\.claude\.runtime\.v1\.Extra/ },
  { name: 'an rpc is added', mutate: (t) => once(t, '  rpc Handshake(HandshakeRequest) returns (HandshakeResponse);\n', '  rpc Handshake(HandshakeRequest) returns (HandshakeResponse);\n  rpc Ping(HandshakeRequest) returns (HandshakeResponse);\n'), added: /new rpc Ping/ },
  { name: 'an event arm is added to the oneof', mutate: (t) => once(t, '    ResumeOutcome resume_outcome = 21;\n', '    ResumeOutcome resume_outcome = 21;\n    ProviderNotice future_notice = 30;\n'), added: /new field optional \.verdandi\.claude\.runtime\.v1\.ProviderNotice future_notice = 30 \(oneof event\)/ },
  { name: 'another tag is reserved', mutate: (t) => once(t, '  reserved 2;\n', '  reserved 2, 44;\n'), added: undefined },
  { name: 'a comment changes', mutate: (t) => once(t, '// ---- Handshake ----', '// ---- Handshake (reworded) ----'), added: undefined },
  { name: 'two fields swap places in the file', mutate: (t) => once(t, '  uint32 protocol_major = 1;\n  uint32 protocol_minor = 2;\n', '  uint32 protocol_minor = 2;\n  uint32 protocol_major = 1;\n'), added: undefined },
];


//! What Eitri 0.2.0 does with the wire, played with the types it was built against (Verdandi
//! b3aa188's runtime.proto, compiled by prost from the frozen copy in ../b3aa188/).
//!
//! Two jobs:
//!
//! 1. `golden_*`: the exact bytes prost puts on the wire for Eitri's requests. The same golden file
//!    (`../b3aa188/eitri-0.2.0-requests.txt`) is replayed against the real sidecar by
//!    `tests/compat/oldClient.conformance.test.ts`, so "what Eitri sends" is written down once and
//!    both the encoder side (here) and the server side (there) are held to it.
//!
//! 2. `decode_*`: the forward-compatibility rules Eitri 0.2.0 leans on when a NEWER sidecar talks to
//!    it -- an enum value it has never heard of, an event arm it has never heard of, a field it has
//!    never heard of. These are properties of prost plus the frozen proto, which is exactly why they
//!    are checked with the real thing and not with a TypeScript stand-in.
//!
//! The request shapes below are copied from Eitri's `agent/src/providers/claude_sidecar/mod.rs`
//! (`build_create_request`, `send_turn`, `interrupt_turn`, `resolve_permission`, `close_session`,
//! and the `WatchSessionEventsRequest` built in the watch loop), as of Eitri's 0.2.0 release line
//! (2026-09-30). If Eitri changes what it sends, that is a change of contract and this file is where
//! it gets written down.

use prost::Message;
use verdandi_old_client_b3aa188::v1::*;

/// `build_create_request` with `crate::process::disallowed_tools()` empty, which it is on every
/// build (Eitri never denies a tool by name: `unrestricted` is derived from the empty list).
fn eitri_create_session_request(
    cwd: &str,
    streaming: StreamingMode,
    resume_provider_session_id: Option<&str>,
    fork: bool,
    provider_prompts: bool,
) -> CreateSessionRequest {
    let denied: Vec<String> = Vec::new();
    CreateSessionRequest {
        cwd: cwd.to_string(),
        policy: Some(ClaudeHostPolicy {
            configuration: ConfigurationProfile::Native as i32,
            permissions: PermissionMode::Interactive as i32,
            persistence: PersistenceMode::HostCli as i32,
            executable: ExecutableSource::HostCli as i32,
            streaming: streaming as i32,
            setting_sources: Some(SettingSourceSelection {
                sources: vec![SettingSource::Project as i32, SettingSource::Local as i32],
            }),
            tool_policy: Some(ToolPolicy {
                deny: denied.clone(),
                unrestricted: denied.is_empty(),
                allow: None,
            }),
            permission_mode_switchable: false,
            provider_permission_prompts: provider_prompts,
        }),
        resume_provider_session_id: resume_provider_session_id.map(str::to_string),
        fork,
        model: None,
        effort: None,
        system_prompt: None,
        output_format: None,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Every request Eitri sends, by the name the golden file uses. Session and command ids are fixed
/// placeholders (`S`, `c1`, `p1`): the real ones are minted per run, and the point here is the SHAPE
/// -- which fields are present, which are omitted, what a zero cursor looks like.
fn eitri_requests() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        (
            "handshake",
            HandshakeRequest { client_protocol_major: 3 }.encode_to_vec(),
        ),
        (
            "create_session_fresh_partial",
            eitri_create_session_request("/tmp/p", StreamingMode::Partial, None, false, true).encode_to_vec(),
        ),
        (
            "create_session_fresh_complete",
            eitri_create_session_request("/tmp/p", StreamingMode::Complete, None, false, true).encode_to_vec(),
        ),
        (
            "create_session_resume_partial",
            eitri_create_session_request("/tmp/p", StreamingMode::Partial, Some("claude-id"), false, true)
                .encode_to_vec(),
        ),
        (
            // First open and every reconnect: AFTER_SEQUENCE with a cursor that is PRESENT even at
            // zero (`after_sequence: Some(tracker.after_sequence())`). An `optional` zero is on the
            // wire; a bare zero would not be, and the sidecar treats the two differently.
            "watch_after_sequence_0",
            WatchSessionEventsRequest {
                session_id: "S".to_string(),
                start: ReplayStart::AfterSequence as i32,
                after_sequence: Some(0),
            }
            .encode_to_vec(),
        ),
        (
            "watch_after_sequence_5",
            WatchSessionEventsRequest {
                session_id: "S".to_string(),
                start: ReplayStart::AfterSequence as i32,
                after_sequence: Some(5),
            }
            .encode_to_vec(),
        ),
        (
            "send_turn",
            SendTurnRequest {
                session_id: "S".to_string(),
                command_id: "c1".to_string(),
                text: "hello".to_string(),
            }
            .encode_to_vec(),
        ),
        (
            "interrupt_turn",
            InterruptTurnRequest {
                session_id: "S".to_string(),
                command_id: "c1".to_string(),
            }
            .encode_to_vec(),
        ),
        (
            // An approval sends no reason: `decision.reason().unwrap_or_default()`.
            "resolve_permission_allow",
            ResolvePermissionRequest {
                session_id: "S".to_string(),
                command_id: "c1".to_string(),
                permission_id: "p1".to_string(),
                allow: true,
                reason: String::new(),
            }
            .encode_to_vec(),
        ),
        (
            "resolve_permission_deny",
            ResolvePermissionRequest {
                session_id: "S".to_string(),
                command_id: "c1".to_string(),
                permission_id: "p1".to_string(),
                allow: false,
                reason: "not now".to_string(),
            }
            .encode_to_vec(),
        ),
        (
            "close_session",
            CloseSessionRequest {
                session_id: "S".to_string(),
                command_id: "c1".to_string(),
            }
            .encode_to_vec(),
        ),
    ]
}

/// Prints the golden file. `cargo test -p verdandi-old-client-b3aa188 print_golden -- --ignored --nocapture`
/// and paste into ../b3aa188/eitri-0.2.0-requests.txt -- only ever when Eitri's own requests changed.
#[test]
#[ignore]
fn print_golden_requests() {
    for (name, bytes) in eitri_requests() {
        println!("{name}\t{}", hex(&bytes));
    }
}

#[test]
fn golden_requests_are_what_prost_encodes_for_eitri() {
    let golden = include_str!("../../b3aa188/eitri-0.2.0-requests.txt");
    let mut on_file: Vec<(&str, &str)> = Vec::new();
    for line in golden.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')) {
        let (name, hex) = line.split_once('\t').expect("golden lines are `name<TAB>hex`");
        on_file.push((name, hex));
    }
    let actual = eitri_requests();
    assert_eq!(
        on_file.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
        actual.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
        "the golden file and this test must name the same requests in the same order"
    );
    for ((name, expected), (_, bytes)) in on_file.iter().zip(actual.iter()) {
        assert_eq!(&hex(bytes), expected, "request `{name}` no longer encodes to the golden bytes");
    }
}

// ---- Forward compatibility: what a NEWER sidecar may send an Eitri 0.2.0 ------------------------

/// A NEWER ErrorDetail: a code this client's proto has no name for, and a field it has never seen.
#[derive(Clone, PartialEq, prost::Message)]
struct NewerErrorDetail {
    #[prost(int32, tag = "1")]
    code: i32,
    #[prost(string, tag = "2")]
    message: String,
    #[prost(string, tag = "3")]
    reason: String,
}

/// Eitri's `map_status`, verbatim in what it does with the bytes: decode, then read `detail.code()`
/// and `detail.message`.
fn eitri_reads_error(bytes: &[u8]) -> (ErrorCode, String) {
    let detail = <ErrorDetail as Message>::decode(bytes).expect("an unknown field must not fail the decode");
    (detail.code(), detail.message)
}

#[test]
fn decode_an_error_code_it_has_never_heard_of_reads_as_unspecified_and_keeps_the_message() {
    let newer = NewerErrorDetail {
        code: 99,
        message: "something new went wrong".to_string(),
        reason: "a field added after b3aa188".to_string(),
    };
    let (code, message) = eitri_reads_error(&newer.encode_to_vec());
    assert_eq!(code, ErrorCode::Unspecified, "prost's `code()` maps an unknown value to the default");
    assert_eq!(message, "something new went wrong", "the message survives, so the user still sees the cause");
    // The raw value is kept too: nothing is lost on the wire, only the name.
    let raw = <ErrorDetail as Message>::decode(newer.encode_to_vec().as_slice()).unwrap();
    assert_eq!(raw.code, 99);
}

#[test]
fn decode_every_known_error_code_still_reads_as_itself() {
    for (value, expected) in [
        (0, ErrorCode::Unspecified),
        (1, ErrorCode::IncompatibleProtocol),
        (2, ErrorCode::UnsupportedCliVersion),
        (3, ErrorCode::SessionNotFound),
        (4, ErrorCode::TurnAlreadyActive),
        (5, ErrorCode::NoActiveTurn),
        (6, ErrorCode::PermissionNotFound),
        (7, ErrorCode::PermissionAlreadyResolved),
        (8, ErrorCode::IdempotencyConflict),
        (9, ErrorCode::EventGap),
        (10, ErrorCode::InvalidConfiguration),
        (11, ErrorCode::ProviderUnavailable),
        (12, ErrorCode::ProviderProtocolError),
        (13, ErrorCode::DeadlineExceeded),
    ] {
        let bytes = NewerErrorDetail { code: value, message: "m".into(), reason: String::new() }.encode_to_vec();
        assert_eq!(eitri_reads_error(&bytes).0, expected, "value {value}");
    }
}

/// A NEWER SessionEvent carrying an event arm this client's proto has no field for.
#[derive(Clone, PartialEq, prost::Message)]
struct NewerNotice {
    #[prost(string, tag = "1")]
    detail: String,
}

#[derive(Clone, PartialEq, prost::Message)]
struct NewerSessionEvent {
    #[prost(string, tag = "1")]
    session_id: String,
    #[prost(uint64, tag = "2")]
    sequence: u64,
    #[prost(int64, tag = "3")]
    occurred_at: i64,
    #[prost(string, optional, tag = "4")]
    turn_id: Option<String>,
    // The oneof's arms are 10..=22 in b3aa188. 23 is the next free one.
    #[prost(message, optional, tag = "23")]
    future_arm: Option<NewerNotice>,
    // ...and so is an ordinary field nobody has defined yet.
    #[prost(string, tag = "40")]
    future_field: String,
}

#[test]
fn decode_an_event_arm_it_has_never_heard_of_is_dropped_but_the_envelope_survives() {
    let newer = NewerSessionEvent {
        session_id: "sidecar-session".to_string(),
        sequence: 7,
        occurred_at: 1_700_000_000_000,
        turn_id: Some("turn-1".to_string()),
        future_arm: Some(NewerNotice { detail: "a safety signal that only exists in a new event".to_string() }),
        future_field: "x".to_string(),
    };
    let event = SessionEvent::decode(newer.encode_to_vec().as_slice()).expect("an unknown arm must not fail the decode");
    // Eitri's `translate_one` does `match event.event? { ... }`: no arm, no domain event.
    assert!(event.event.is_none(), "the unknown arm is silently dropped -- which is why no safety signal may live only in a new event");
    // The sequence still counts: Eitri's SequenceTracker sees a gapless stream even across an
    // event it could not read.
    assert_eq!(event.sequence, 7);
    assert_eq!(event.session_id, "sidecar-session");
    assert_eq!(event.turn_id.as_deref(), Some("turn-1"));
}

#[test]
fn decode_a_known_arm_is_unaffected_by_unknown_fields_beside_it() {
    #[derive(Clone, PartialEq, prost::Message)]
    struct NewerTextDelta {
        #[prost(string, tag = "1")]
        turn_id: String,
        #[prost(string, tag = "2")]
        text: String,
        #[prost(string, optional, tag = "3")]
        message_id: Option<String>,
        #[prost(string, tag = "9")]
        added_later: String,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    struct NewerEvent {
        #[prost(string, tag = "1")]
        session_id: String,
        #[prost(uint64, tag = "2")]
        sequence: u64,
        #[prost(message, optional, tag = "12")]
        text_delta: Option<NewerTextDelta>,
    }
    let bytes = NewerEvent {
        session_id: "s".into(),
        sequence: 3,
        text_delta: Some(NewerTextDelta {
            turn_id: "t".into(),
            text: "hi".into(),
            message_id: Some("msg_1".into()),
            added_later: "ignored".into(),
        }),
    }
    .encode_to_vec();
    let event = SessionEvent::decode(bytes.as_slice()).unwrap();
    match event.event {
        Some(session_event::Event::TextDelta(delta)) => {
            assert_eq!(delta.text, "hi");
            assert_eq!(delta.message_id.as_deref(), Some("msg_1"));
        }
        other => panic!("expected a TextDelta, got {other:?}"),
    }
}

#[test]
fn decode_an_enum_value_it_has_never_heard_of_inside_a_known_message_keeps_the_rest() {
    // TurnCompleted.outcome = 77 (a NEWER outcome), usage and text intact.
    #[derive(Clone, PartialEq, prost::Message)]
    struct NewerTurnCompleted {
        #[prost(string, tag = "1")]
        turn_id: String,
        #[prost(int32, tag = "2")]
        outcome: i32,
        #[prost(string, tag = "3")]
        result_text: String,
    }
    let bytes = NewerTurnCompleted { turn_id: "t".into(), outcome: 77, result_text: "done".into() }.encode_to_vec();
    let completed = TurnCompleted::decode(bytes.as_slice()).unwrap();
    assert_eq!(completed.outcome(), TurnOutcome::Unspecified);
    assert_eq!(completed.result_text, "done");
    assert_eq!(completed.outcome, 77);
}

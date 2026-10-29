//! The Rust half of the one-source rule: `capabilities.json` is the only place the protocol numbers,
//! the capability strings and the permission-mode strings are written, and the constants this crate
//! exports are generated from it by build.rs. This test reads the same file and fails if a constant
//! or a list disagrees with it, so a change to the generator that stops tracking the file is caught
//! here rather than by a host. The TypeScript half is `apps/claude-sidecar/tests/protocolSource.test.ts`.

use claude_runtime_protocol::*;
use prost::Message;
use serde_json::Value;

fn source() -> Value {
    serde_json::from_str(include_str!("../capabilities.json")).expect("capabilities.json is JSON")
}

fn names(doc: &Value) -> Vec<&str> {
    doc["capabilities"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect()
}

#[test]
fn the_protocol_numbers_are_the_files() {
    let doc = source();
    assert_eq!(u64::from(PROTOCOL_MAJOR), doc["protocol"]["major"].as_u64().unwrap());
    assert_eq!(u64::from(PROTOCOL_MINOR), doc["protocol"]["minor"].as_u64().unwrap());
    // Eitri 0.2.0 handshakes with major 3 and a sidecar that answered anything else would lock it out.
    assert_eq!(PROTOCOL_MAJOR, 3);
}

#[test]
fn the_capability_list_is_the_files_in_the_files_order() {
    let doc = source();
    assert_eq!(CAPABILITIES.to_vec(), names(&doc));
}

#[test]
fn the_capability_constants_a_host_reads_have_the_files_spelling() {
    // Named one by one, not through CAPABILITIES: a constant misnamed or mis-valued by the generator
    // would still sit in the list it was built into, so the names are checked against literals. The
    // ones Eitri 0.2.0 reads, plus the first and the last of the list; a new capability needs no row.
    let expected: &[(&str, &str)] = &[
        (CAP_HANDSHAKE, "handshake"),
        (CAP_INTERRUPT_TURN, "interrupt_turn"),
        (CAP_RESUME_SESSION, "resume_session"),
        (CAP_SETTING_SOURCES, "setting_sources"),
        (CAP_TOOL_POLICY, "tool_policy"),
        (CAP_TEXT_DELTA_MESSAGE_ID, "text_delta_message_id"),
        (CAP_PROVIDER_PERMISSION_PROMPTS, "provider_permission_prompts"),
        (CAP_EXECUTABLE_HOST_CLI, "executable_host_cli"),
        (CAP_EXECUTABLE_SDK_BUNDLED, "executable_sdk_bundled"),
    ];
    for (constant, literal) in expected {
        assert_eq!(constant, literal);
        assert!(CAPABILITIES.contains(literal), "{literal} is not in CAPABILITIES");
    }
}

#[test]
fn the_baseline_is_the_flagged_capabilities_and_the_documented_eleven() {
    let doc = source();
    let flagged: Vec<&str> = doc["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["baseline"].as_bool() == Some(true))
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(BASELINE_CAPABILITIES.to_vec(), flagged);
    // What major 3 itself guarantees (COMPATIBILITY.md). Growing this list is a major bump.
    assert_eq!(
        BASELINE_CAPABILITIES,
        [
            "handshake",
            "create_session",
            "send_turn",
            "watch_session_events",
            "interrupt_turn",
            "resolve_permission",
            "close_session",
            "resume_session",
            "fork_session",
            "setting_sources",
            "tool_policy",
        ]
    );
}

#[test]
fn every_capability_reports_the_minor_that_introduced_it() {
    let doc = source();
    let expected: Vec<(&str, u64)> = doc["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["name"].as_str().unwrap(), c["since_minor"].as_u64().unwrap()))
        .collect();
    let actual: Vec<(&str, u64)> = CAPABILITY_SINCE_MINOR.iter().map(|(name, minor)| (*name, u64::from(*minor))).collect();
    assert_eq!(actual, expected);
    assert!(CAPABILITY_SINCE_MINOR.iter().all(|(_, minor)| *minor <= PROTOCOL_MINOR));
}

#[test]
fn the_permission_modes_are_the_files() {
    let doc = source();
    let modes: Vec<&str> = doc["permission_modes"].as_array().unwrap().iter().map(|m| m.as_str().unwrap()).collect();
    assert_eq!(PERMISSION_MODES.to_vec(), modes);
    assert_eq!(PERMISSION_MODE_INTERACTIVE, "interactive");
    assert_eq!(PERMISSION_MODE_VERDANDI_RULES, "verdandi_rules");
    assert_eq!(PERMISSION_MODE_BYPASS, "bypass");
    assert_eq!(PERMISSION_MODES.len(), 3);
}

#[test]
fn the_generated_types_are_still_reachable_beside_the_constants() {
    // The constants are additive: the prost module keeps its place and its names.
    let response = v1::HandshakeResponse { protocol_major: PROTOCOL_MAJOR, protocol_minor: PROTOCOL_MINOR, ..Default::default() };
    assert_eq!(response.protocol_minor, PROTOCOL_MINOR);
}

#[test]
fn preset_presence_survives_wire_round_trip() {
    // The preset arrived at 21; later minors keep it.
    assert!(PROTOCOL_MINOR >= 21);
    assert_eq!(CAP_SYSTEM_PROMPT_PRESET, "system_prompt_preset");
    let presets = [
        None,
        Some(v1::SystemPromptPreset { append: None }),
        Some(v1::SystemPromptPreset { append: Some("panel note".into()) }),
    ];
    let mut wires = Vec::new();
    for preset in presets {
        let request = v1::CreateSessionRequest { system_prompt_preset: preset.clone(), ..Default::default() };
        let wire = request.encode_to_vec();
        let decoded = v1::CreateSessionRequest::decode(wire.as_slice()).unwrap();
        assert_eq!(decoded.system_prompt_preset, preset);
        assert_eq!(decoded.system_prompt, None);
        wires.push(wire);
    }
    assert_ne!(wires[0], wires[1]);
    assert_ne!(wires[1], wires[2]);
    assert_ne!(wires[0], wires[2]);
}

#[test]
fn protocol_3_22_messages_compile_and_survive_a_round_trip() {
    use v1::session_event::Event;
    assert_eq!(PROTOCOL_MINOR, 22);
    let events = [
        Event::TurnCauseUpdated(v1::TurnCauseUpdated {
            turn_id: "t1".into(),
            cause: Some(v1::TurnCause { kind: v1::TurnCauseKind::Task as i32, task_id: Some("b1".into()), ..Default::default() }),
        }),
        Event::CliCycleStarted(v1::CliCycleStarted { turn_id: "t1".into(), cause: None }),
        Event::BackgroundTasksChanged(v1::BackgroundTasksChanged {
            tasks: vec![v1::BackgroundTask { task_id: "b1".into(), kind: v1::TaskKind::Shell as i32, ..Default::default() }],
        }),
        Event::TaskEvent(v1::TaskEvent {
            edge: v1::TaskEdge::Notified as i32,
            task_id: "b1".into(),
            status: Some(v1::TaskStatus::Killed as i32),
            workflow_progress: Some(v1::WorkflowProgress { phases: vec![], agents: vec![v1::WorkflowAgent { index: 1, ..Default::default() }] }),
            ..Default::default()
        }),
        Event::SessionNotice(v1::SessionNotice {
            kind: v1::SessionNoticeKind::PeerHold as i32,
            level: v1::NoticeLevel::Warning as i32,
            hold_state: Some(v1::PeerHoldState::Dropped as i32),
            ..Default::default()
        }),
        Event::ConversationReset(v1::ConversationReset { new_conversation_id: "c2".into(), trigger: None }),
        Event::InteractionRequested(v1::InteractionRequested {
            interaction_id: "i1".into(),
            kind: v1::InteractionKind::Question as i32,
            payload: Some(v1::interaction_requested::Payload::Questions(v1::QuestionSet { questions: vec![] })),
            ..Default::default()
        }),
        Event::InteractionResolved(v1::InteractionResolved {
            interaction_id: "i1".into(),
            outcome: v1::InteractionOutcome::HostRefused as i32,
            ..Default::default()
        }),
    ];
    for event in events {
        let sent = v1::SessionEvent { session_id: "s".into(), event: Some(event), ..Default::default() };
        let decoded = v1::SessionEvent::decode(sent.encode_to_vec().as_slice()).unwrap();
        assert_eq!(decoded, sent);
    }
    assert_eq!(v1::ErrorCode::TaskNotFound as i32, 16);
    assert_eq!(v1::ErrorCode::TaskOutputUnavailable as i32, 17);
    assert_eq!(v1::ErrorCode::InteractionNotFound as i32, 30);
    assert_eq!(v1::ErrorCode::InteractionAnswerRefused as i32, 31);
    let request = v1::SendTurnRequest { client_message_id: Some("m1".into()), typed_by_person: true, ..Default::default() };
    assert_eq!(v1::SendTurnRequest::decode(request.encode_to_vec().as_slice()).unwrap(), request);
    let stop = v1::StopTaskRequest { session_id: "s".into(), command_id: "c".into(), task_id: "b1".into() };
    assert_eq!(v1::StopTaskRequest::decode(stop.encode_to_vec().as_slice()).unwrap(), stop);
    let output = v1::GetTaskOutputResponse { output: vec![0xe2, 0x82], total_bytes: 2, truncated: true };
    assert_eq!(v1::GetTaskOutputResponse::decode(output.encode_to_vec().as_slice()).unwrap(), output);
}

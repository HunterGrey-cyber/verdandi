//! The Rust half of the one-source rule: `capabilities.json` is the only place the protocol numbers,
//! the capability strings and the permission-mode strings are written, and the constants this crate
//! exports are generated from it by build.rs. This test reads the same file and fails if a constant
//! or a list disagrees with it, so a change to the generator that stops tracking the file is caught
//! here rather than by a host. The TypeScript half is `apps/claude-sidecar/tests/protocolSource.test.ts`.

use claude_runtime_protocol::*;
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

// Compiles the FROZEN proto (../b3aa188/runtime.proto, the copy of Verdandi b3aa188's
// proto/verdandi/claude/runtime/v1/runtime.proto) exactly the way crates/claude-runtime-protocol's
// build.rs compiles the live one, so the generated types are the ones Eitri 0.2.0 links.
//
// The frozen file lives beside the TypeScript compat tests and is shared with them: one copy, whose
// meaning (not its comments) is pinned by a fingerprint in tests/compat/frozenProto.test.ts.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../b3aa188/runtime.proto");
    tonic_prost_build::configure()
        .build_server(false)
        .compile_protos(&["../b3aa188/runtime.proto"], &["../b3aa188"])?;
    Ok(())
}

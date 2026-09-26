fn main() -> Result<(), Box<dyn std::error::Error>> {
    // No Rust server this round -- verdandi's server is the Node sidecar; this crate is a future
    // Rust CLIENT's dependency only (design spec §1, §9). build_server(false) avoids generating and
    // compiling server-side trait scaffolding with zero consumers.
    //
    // NOTE: as of tonic 0.13/0.14, prost codegen (configure()/compile()) moved out of `tonic-build`
    // into `tonic-prost-build`, and `compile()` was renamed `compile_protos()` -- this plan's brief
    // was written against the pre-split tonic 0.12 API. This is the current-stable equivalent;
    // `tonic::include_proto!` in src/lib.rs is unaffected since it just includes a generated file by
    // package name, regardless of which build crate produced it.
    // The proto lives OUTSIDE this package (`../../proto`), and cargo's default rerun heuristic only
    // watches files inside the package directory -- so without these, editing the contract leaves
    // the previously generated code in place and the crate compiles, and passes tests, against a
    // contract that no longer exists. Reported by a sibling runtime track, which hit exactly this
    // in its own protocol crate: 4 tests green against a deleted shape.
    //
    // A fresh `rev`-pinned checkout (how neovibe consumes this crate) builds once and is unaffected;
    // the hole is for anyone editing the proto inside this repo, which is now everyone doing
    // protocol work.
    println!("cargo:rerun-if-changed=../../proto/verdandi/claude/runtime/v1/runtime.proto");
    println!("cargo:rerun-if-changed=../../proto");

    tonic_prost_build::configure()
        .build_server(false)
        .compile_protos(
            &["../../proto/verdandi/claude/runtime/v1/runtime.proto"],
            &["../../proto"],
        )?;
    Ok(())
}

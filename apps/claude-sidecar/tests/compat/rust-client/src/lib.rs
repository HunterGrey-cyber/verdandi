//! The types Eitri 0.2.0 compiles against: Verdandi b3aa188's `runtime.proto`, frozen.
//!
//! Test support only (see `tests/old_client.rs`). Nothing here is a behaviour of Verdandi.

pub mod v1 {
    tonic::include_proto!("verdandi.claude.runtime.v1");
}

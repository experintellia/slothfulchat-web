//! `tokio` facade for chatmail core.
//!
//! Core (and deltachat-jsonrpc) depend on this crate under the name `tokio`
//! via Cargo package rename. Cargo requires one canonical source per
//! dependency name across all targets, so the facade covers both:
//!
//! - native: transparent re-export of real tokio (feature `full`)
//! - wasm32: real tokio's `sync`/`io`/macros (which work on wasm) plus
//!   browser implementations — time via `wasmtimer`, tasks on the JS event
//!   loop, an in-memory `fs`, and compile-compatible `net` stubs.

#[cfg(not(target_arch = "wasm32"))]
pub use tokio::*;

#[cfg(target_arch = "wasm32")]
pub use tokio::{io, join, pin, select, sync, task_local, try_join};

#[cfg(target_arch = "wasm32")]
pub mod fs;
#[cfg(target_arch = "wasm32")]
pub mod net;
#[cfg(target_arch = "wasm32")]
pub mod runtime;
#[cfg(target_arch = "wasm32")]
pub mod task;
#[cfg(target_arch = "wasm32")]
pub mod time;

#[cfg(target_arch = "wasm32")]
pub use task::spawn;

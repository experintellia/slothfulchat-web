//! Timers backed by JS `setTimeout` via `wasmtimer` (tokio's own timers panic
//! on wasm32-unknown-unknown).

pub use std::time::Duration;

pub use wasmtimer::tokio::{sleep, sleep_until, timeout};
pub use wasmtimer::tokio::{Sleep, Timeout};

pub mod error {
    pub use wasmtimer::tokio::error::Elapsed;
}

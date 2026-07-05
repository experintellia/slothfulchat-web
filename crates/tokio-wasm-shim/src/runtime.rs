//! Runtime handle stub — there is no tokio runtime on wasm; tasks run on the
//! browser event loop, so `Handle` just forwards to [`crate::task`].

use std::future::Future;

#[derive(Clone, Debug)]
pub struct Handle;

impl Handle {
    pub fn current() -> Handle {
        Handle
    }

    pub fn spawn<F>(&self, future: F) -> crate::task::JoinHandle<F::Output>
    where
        F: Future + 'static,
        F::Output: 'static,
    {
        crate::task::spawn(future)
    }

    pub fn spawn_blocking<F, R>(&self, f: F) -> crate::task::JoinHandle<R>
    where
        F: FnOnce() -> R + 'static,
        R: 'static,
    {
        crate::task::spawn_blocking(f)
    }
}

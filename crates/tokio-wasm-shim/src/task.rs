//! Task spawning on the browser event loop.
//!
//! ponytail: single-threaded — `spawn` has no `Send` bound, `spawn_blocking`
//! and `block_in_place` run inline (a web-worker pool is the upgrade path if
//! long PGP operations blocking the UI become a problem).

use std::cell::Cell;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use futures::channel::oneshot;
use futures::future::{AbortHandle as InnerAbortHandle, Abortable};
use futures::stream::FuturesUnordered;
use futures::StreamExt;

pub use tokio::task::LocalKey;

/// Error returned by awaiting a [`JoinHandle`] whose task was aborted.
#[derive(Debug)]
pub struct JoinError {
    cancelled: bool,
}

impl JoinError {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    pub fn is_panic(&self) -> bool {
        !self.cancelled
    }
}

impl std::fmt::Display for JoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.cancelled {
            write!(f, "task was cancelled")
        } else {
            write!(f, "task failed")
        }
    }
}

impl std::error::Error for JoinError {}

pub struct JoinHandle<T> {
    rx: oneshot::Receiver<T>,
    abort: InnerAbortHandle,
    finished: Arc<AtomicBool>,
}

impl<T> std::fmt::Debug for JoinHandle<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JoinHandle")
            .field("finished", &self.is_finished())
            .finish_non_exhaustive()
    }
}

impl<T> JoinHandle<T> {
    pub fn abort(&self) {
        self.abort.abort();
    }

    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Relaxed)
    }

    pub fn abort_handle(&self) -> AbortHandle {
        AbortHandle(self.abort.clone())
    }
}

#[derive(Clone, Debug)]
pub struct AbortHandle(InnerAbortHandle);

impl AbortHandle {
    pub fn abort(&self) {
        self.0.abort();
    }
}

impl<T> Future for JoinHandle<T> {
    type Output = Result<T, JoinError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.rx)
            .poll(cx)
            .map(|r| r.map_err(|_| JoinError { cancelled: true }))
    }
}

pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + 'static,
    F::Output: 'static,
{
    let (tx, rx) = oneshot::channel();
    let (abort, registration) = InnerAbortHandle::new_pair();
    let finished = Arc::new(AtomicBool::new(false));
    let finished2 = finished.clone();
    wasm_bindgen_futures::spawn_local(async move {
        if let Ok(value) = Abortable::new(future, registration).await {
            let _ = tx.send(value);
        }
        finished2.store(true, Ordering::Relaxed);
    });
    JoinHandle {
        rx,
        abort,
        finished,
    }
}

pub fn spawn_blocking<F, R>(f: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + 'static,
    R: 'static,
{
    let (tx, rx) = oneshot::channel();
    let (abort, _registration) = InnerAbortHandle::new_pair();
    let _ = tx.send(run_timed(f));
    JoinHandle {
        rx,
        abort,
        finished: Arc::new(AtomicBool::new(true)),
    }
}

pub fn block_in_place<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    run_timed(f)
}

// --- Step 0 profiling for issue #3 ------------------------------------------
//
// `spawn_blocking`/`block_in_place` run inline on the single core worker, so
// their closures are exactly the CPU-heavy PGP paths (keygen, encrypt, decrypt)
// that make other jsonrpc calls queue. Before building the worker-pool offload,
// issue #3 asks to *profile first*: measure how much wall time these inline
// closures actually eat. This wraps every such closure with a timer, keeps a
// running total, and logs individually slow ones. All local, dev-facing.
// (Surfacing `blocking_profile()` to the diagnostics panel needs a small RPC and
// is left for the offload work itself.)
// https://github.com/experintellia/slothfulchat-web/issues/3

thread_local! {
    static BLOCKING_TOTAL_MS: Cell<f64> = Cell::new(0.0);
    static BLOCKING_COUNT: Cell<u32> = Cell::new(0);
    static BLOCKING_MAX_MS: Cell<f64> = Cell::new(0.0);
}

/// Aggregate wall time spent running inline blocking closures this session.
#[derive(Clone, Copy, Debug, Default)]
pub struct BlockingProfile {
    pub total_ms: f64,
    pub count: u32,
    pub max_ms: f64,
}

/// Snapshot the inline-blocking profile (issue #3, Step 0).
pub fn blocking_profile() -> BlockingProfile {
    BlockingProfile {
        total_ms: BLOCKING_TOTAL_MS.with(Cell::get),
        count: BLOCKING_COUNT.with(Cell::get),
        max_ms: BLOCKING_MAX_MS.with(Cell::get),
    }
}

// only log individually slow closures, to keep the console usable
const SLOW_BLOCKING_MS: f64 = 4.0;

/// Run a blocking closure inline, folding its wall time into the profile.
fn run_timed<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    // Date::now() (ms) is coarse but ample for keygen/encrypt/decrypt, and
    // needs no extra web-sys feature (performance.now() would).
    let start = js_sys::Date::now();
    let out = f();
    let dur = js_sys::Date::now() - start;

    BLOCKING_TOTAL_MS.with(|c| c.set(c.get() + dur));
    BLOCKING_COUNT.with(|c| c.set(c.get() + 1));
    BLOCKING_MAX_MS.with(|c| c.set(c.get().max(dur)));

    if dur >= SLOW_BLOCKING_MS {
        let total = BLOCKING_TOTAL_MS.with(Cell::get);
        web_sys::console::debug_1(&wasm_bindgen::JsValue::from_str(&format!(
            "sc:blocking {dur:.0}ms (session total {total:.0}ms)"
        )));
    }

    out
}

pub async fn yield_now() {
    struct YieldNow(bool);

    impl Future for YieldNow {
        type Output = ();

        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
            if self.0 {
                Poll::Ready(())
            } else {
                self.0 = true;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        }
    }

    YieldNow(false).await
}

pub struct JoinSet<T> {
    handles: FuturesUnordered<JoinHandle<T>>,
}

impl<T: 'static> JoinSet<T> {
    pub fn new() -> Self {
        Self {
            handles: FuturesUnordered::new(),
        }
    }

    pub fn spawn<F>(&mut self, task: F) -> AbortHandle
    where
        F: Future<Output = T> + 'static,
    {
        let handle = spawn(task);
        let abort = handle.abort_handle();
        self.handles.push(handle);
        abort
    }

    pub async fn join_next(&mut self) -> Option<Result<T, JoinError>> {
        self.handles.next().await
    }

    pub fn len(&self) -> usize {
        self.handles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.handles.is_empty()
    }

    pub fn abort_all(&mut self) {
        for handle in self.handles.iter_mut() {
            handle.abort();
        }
    }

    /// Aborts all tasks and waits for them to finish.
    pub async fn shutdown(&mut self) {
        self.abort_all();
        while self.join_next().await.is_some() {}
    }

    /// Awaits completion of all tasks, discarding cancelled ones.
    pub async fn join_all(mut self) -> Vec<T> {
        let mut results = Vec::new();
        while let Some(result) = self.join_next().await {
            if let Ok(value) = result {
                results.push(value);
            }
        }
        results
    }
}

impl<T: 'static> Default for JoinSet<T> {
    fn default() -> Self {
        Self::new()
    }
}

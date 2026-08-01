//! Retry policy and loss bookkeeping for the OPFS write-through in
//! [`crate::opfs`].
//!
//! Kept free of `web_sys` so it compiles — and unit-tests — on native too, the
//! same way [`crate::registry`] is: the give-up decision is what turns a
//! transient quota blip into permanent data loss, so it gets real coverage
//! instead of living inline in wasm-only code. Everything that actually talks
//! to OPFS stays in `opfs.rs`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// Attempts a queued path gets before its write is declared lost: the first
/// try plus three retries.
pub const MAX_ATTEMPTS: u32 = 4;

/// Backoff before retry N (50ms, 200ms, 800ms). Long enough for a quota blip
/// or a competing sync access handle to clear, short enough that the FIFO
/// behind a doomed path stalls for ~1s at worst.
const BACKOFF_MS: [u64; MAX_ATTEMPTS as usize - 1] = [50, 200, 800];

/// Monotonic count of write-throughs that never reached OPFS. Callers snapshot
/// it before work whose durability matters and diff it afterwards (see
/// `opfs::flush_pending`), so it must only ever count *permanent* loss — a
/// write that failed once and succeeded on retry is durable.
static LOST: AtomicUsize = AtomicUsize::new(0);

/// What the flusher does after one reconcile attempt for a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// The write is durable; move on to the next queued path.
    Done,
    /// Transient failure — sleep this long, then reconcile the path again.
    /// A retry re-snapshots the memfs, so it always writes current state.
    Retry(Duration),
    /// Out of attempts: this write will never reach OPFS. Record it and shout.
    Permanent,
}

/// Decides what follows a reconcile attempt; `attempt` is 1-based.
///
/// ponytail: retries every error instead of classifying the DOMException. The
/// recoverable ones (quota pressure a concurrent delete relieves, a handle the
/// browser invalidated) are not reliably distinguishable by name from the
/// hopeless ones, and guessing wrong costs user data; the bounded backoff caps
/// the price of retrying a hopeless write at ~1s. Upgrade path: match on
/// `err.name()` to skip the backoff for errors known to be terminal.
pub fn next_step(ok: bool, attempt: u32) -> Next {
    if ok {
        Next::Done
    } else if attempt >= MAX_ATTEMPTS {
        Next::Permanent
    } else {
        Next::Retry(Duration::from_millis(
            *BACKOFF_MS
                .get(attempt.saturating_sub(1) as usize)
                .unwrap_or(&BACKOFF_MS[BACKOFF_MS.len() - 1]),
        ))
    }
}

/// Records a permanently lost write-through. Call once per give-up.
pub fn record_lost() {
    LOST.fetch_add(1, Ordering::SeqCst);
}

/// Snapshot of the lost-write counter (see [`LOST`]).
pub fn lost_count() -> u32 {
    LOST.load(Ordering::SeqCst) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drives one queued path exactly the way `opfs::flusher` does, with
    /// `outcomes` standing in for the reconcile results (missing entry =
    /// another failure). Returns attempts made, backoffs slept, gave-up.
    fn drive(outcomes: &[bool]) -> (u32, Vec<Duration>, bool) {
        let mut backoffs = Vec::new();
        let mut attempt: u32 = 1;
        loop {
            let ok = outcomes
                .get(attempt.saturating_sub(1) as usize)
                .copied()
                .unwrap_or(false);
            match next_step(ok, attempt) {
                Next::Done => return (attempt, backoffs, false),
                Next::Retry(after) => {
                    backoffs.push(after);
                    attempt += 1;
                }
                Next::Permanent => {
                    record_lost();
                    return (attempt, backoffs, true);
                }
            }
        }
    }

    #[test]
    fn transient_failure_is_retried_not_lost() {
        let (attempts, backoffs, gave_up) = drive(&[false, false, true]);
        assert_eq!(attempts, 3, "must retry until the write succeeds");
        assert_eq!(backoffs.len(), 2);
        assert!(backoffs[1] > backoffs[0], "backoff must grow");
        assert!(
            !gave_up,
            "a retried-then-durable write must not count as lost"
        );
    }

    #[test]
    fn permanent_failure_gives_up_bounded_and_is_counted() {
        // The only test that touches the global counter, so the delta is stable
        // even though cargo runs tests in parallel.
        let before = lost_count();
        let (attempts, backoffs, gave_up) = drive(&[]);
        assert!(gave_up);
        assert_eq!(attempts, MAX_ATTEMPTS, "retrying must be bounded");
        // The whole retry budget has to stay well inside `flush_pending`'s ~30s
        // cap, or one doomed path would hang every barrier queued behind it.
        assert!(backoffs.iter().sum::<Duration>() < Duration::from_secs(5));
        assert_eq!(
            lost_count(),
            before + 1,
            "a permanently lost write must be observable, not silently swallowed"
        );
    }
}

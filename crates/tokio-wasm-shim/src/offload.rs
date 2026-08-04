//! JS-offload bridge: hand heavy work (PGP) to a JS-side worker pool.
//!
//! JS registers a handler `(op: string, payload: Uint8Array) -> Promise<Uint8Array>`
//! via [`set_handler`]; core call sites check [`available`] and use [`offload`],
//! falling back to inline `spawn_blocking` when no handler is registered.

use std::cell::RefCell;

use wasm_bindgen::{JsCast, JsValue};

thread_local! {
    static HANDLER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Registers the JS handler used by [`offload`].
pub fn set_handler(f: js_sys::Function) {
    HANDLER.with(|h| *h.borrow_mut() = Some(f));
}

/// Whether an offload handler has been registered.
pub fn available() -> bool {
    HANDLER.with(|h| h.borrow().is_some())
}

fn err(context: &str, e: JsValue) -> String {
    format!("{context}: {}", e.as_string().unwrap_or_else(|| format!("{e:?}")))
}

/// Calls the registered JS handler (op: string, payload: Uint8Array) -> Promise<Uint8Array>.
pub async fn offload(op: &str, payload: Vec<u8>) -> Result<Vec<u8>, String> {
    let handler = HANDLER
        .with(|h| h.borrow().clone())
        .ok_or_else(|| "no offload handler".to_string())?;
    let ret = handler
        .call2(
            &JsValue::NULL,
            &op.into(),
            &js_sys::Uint8Array::from(&payload[..]),
        )
        .map_err(|e| err("offload call failed", e))?;
    let promise: js_sys::Promise = ret
        .dyn_into()
        .map_err(|v| err("offload handler did not return a Promise", v))?;
    let resolved = wasm_bindgen_futures::JsFuture::from(promise)
        .await
        .map_err(|e| err("offload rejected", e))?;
    let bytes: js_sys::Uint8Array = resolved
        .dyn_into()
        .map_err(|v| err("offload did not resolve to a Uint8Array", v))?;
    Ok(bytes.to_vec())
}

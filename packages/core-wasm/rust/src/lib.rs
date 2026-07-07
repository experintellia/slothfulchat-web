//! Browser entry point for chatmail core.
//!
//! Mirrors deltachat-rpc-server, with stdio replaced by a JS callback
//! (core → JS) and [`DeltaChat::receive`] (JS → core). Both sides carry
//! plain JSON-RPC strings, so the standard `@deltachat/jsonrpc-client`
//! TypeScript package works on top unchanged.

use std::path::PathBuf;
use std::sync::Arc;

use deltachat_jsonrpc::api::{Accounts, CommandApi};
use futures_lite::stream::StreamExt;
use tokio::sync::RwLock;
use wasm_bindgen::prelude::*;
use yerpc::{RpcClient, RpcSession};

#[wasm_bindgen]
pub struct DeltaChat {
    session: RpcSession<CommandApi>,
}

/// Starts chatmail core with the accounts directory at `/accounts` (in-memory
/// filesystem) and returns a handle speaking JSON-RPC.
///
/// `on_message` is called with every outgoing JSON-RPC message (responses and
/// event notifications) as a string.
///
/// `ws_proxy_url` (optional, e.g. `ws://localhost:8641`) points at a
/// WebSocket→TCP proxy for IMAP/SMTP/DNS; without it all networking errors.
#[wasm_bindgen]
pub async fn init(
    on_message: js_sys::Function,
    ws_proxy_url: Option<String>,
) -> Result<DeltaChat, JsValue> {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Info);

    if let Some(url) = ws_proxy_url {
        deltachat::net::ws_tcp::set_ws_proxy_url(url);
    }

    let accounts = Accounts::new(PathBuf::from("/accounts"), true)
        .await
        .map_err(|e| JsValue::from_str(&format!("failed to create accounts: {e:#}")))?;
    let accounts = Arc::new(RwLock::new(accounts));
    let state = CommandApi::from_arc(accounts).await;

    let (client, mut out_receiver) = RpcClient::new();
    let session = RpcSession::new(client, state);

    wasm_bindgen_futures::spawn_local(async move {
        while let Some(message) = out_receiver.next().await {
            match serde_json::to_string(&message) {
                Ok(message) => {
                    let _ = on_message.call1(&JsValue::NULL, &JsValue::from_str(&message));
                }
                Err(err) => log::error!("failed to serialize RPC message: {err}"),
            }
        }
    });

    Ok(DeltaChat { session })
}

fn fs_err(err: std::io::Error) -> JsValue {
    JsValue::from_str(&err.to_string())
}

#[wasm_bindgen]
impl DeltaChat {
    /// Feeds one incoming JSON-RPC message (request string) to core.
    /// Responses arrive via the `on_message` callback passed to `init`.
    pub fn receive(&self, message: String) {
        let session = self.session.clone();
        wasm_bindgen_futures::spawn_local(async move {
            session.handle_incoming(&message).await;
        });
    }

    // fs side channel into the in-memory filesystem core runs on
    // (blob display, temp files, backup import/export).

    pub fn fs_read(&self, path: String) -> Result<js_sys::Uint8Array, JsValue> {
        let data = tokio::fs::sync_read(&path).map_err(fs_err)?;
        Ok(js_sys::Uint8Array::from(data.as_slice()))
    }

    /// Creates parent directories automatically.
    pub fn fs_write(&self, path: String, data: &[u8]) -> Result<(), JsValue> {
        tokio::fs::sync_write(&path, data).map_err(fs_err)
    }

    /// Removes a file or a directory tree.
    pub fn fs_remove(&self, path: String) -> Result<(), JsValue> {
        tokio::fs::sync_remove(&path).map_err(fs_err)
    }

    pub fn fs_exists(&self, path: String) -> bool {
        tokio::fs::sync_exists(&path)
    }

    pub fn fs_mkdirp(&self, path: String) -> Result<(), JsValue> {
        tokio::fs::sync_create_dir_all(&path).map_err(fs_err)
    }
}

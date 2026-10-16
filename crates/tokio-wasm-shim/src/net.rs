//! Browser networking. Browsers cannot open TCP sockets, so:
//!
//! - [`TcpStream`] tunnels a byte stream through a WebSocket proxy that
//!   exposes `/tcp/{ip}/{port}` as a raw tunnel (`packages/ws-tcp-proxy`);
//!   TLS still terminates inside wasm, the proxy only ever relays ciphertext.
//! - [`lookup_host`] resolves through the same proxy's `/dns/{host}` endpoint.
//! - [`fetch`] is HTTP via the browser's `fetch()` (not a tokio API; core's
//!   wasm `net/http` module is a thin adapter over it).
//!
//! JS handles are `!Send`, but core requires `Send` streams and futures. All
//! JS work therefore runs in local tasks ([`crate::task::spawn`]) and only
//! plain Rust values cross back: a `tokio::io::duplex` pair for the socket,
//! a `Vec` for DNS and fetch results.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};
use std::time::Duration;

use futures::StreamExt;
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};
use tokio_util::compat::FuturesAsyncReadCompatExt;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

static WS_PROXY_URL: OnceLock<String> = OnceLock::new();

/// Configures the WebSocket proxy base URL (e.g. `ws://localhost:8641`).
/// Must be called before any network operation; subsequent calls are ignored.
pub fn set_ws_proxy_url(url: String) {
    let _ = WS_PROXY_URL.set(url);
}

fn other(msg: impl Into<String>) -> io::Error {
    io::Error::other(msg.into())
}

fn proxy_url(kind: &str, host: &str, port: Option<u16>) -> io::Result<String> {
    let base = WS_PROXY_URL
        .get()
        .ok_or_else(|| other("no WebSocket proxy configured — call set_ws_proxy_url() first"))?;
    let base = base.trim_end_matches('/');
    Ok(match port {
        Some(port) => format!("{base}/{kind}/{host}/{port}"),
        None => format!("{base}/{kind}/{host}"),
    })
}

/// A TCP connection tunneled through the WebSocket proxy.
#[derive(Debug)]
pub struct TcpStream {
    inner: DuplexStream,
    peer: SocketAddr,
}

impl TcpStream {
    /// Opens a tunneled TCP connection to `addr` via the proxy.
    ///
    /// ponytail: takes a resolved `SocketAddr` only (all core passes);
    /// resolve names with [`lookup_host`] first.
    pub async fn connect(addr: SocketAddr) -> io::Result<TcpStream> {
        let url = proxy_url("tcp", &addr.ip().to_string(), Some(addr.port()))?;
        let inner = crate::task::spawn(async move { connect_inner(&url).await })
            .await
            .map_err(|_| other("ws connect task dropped"))??;
        Ok(TcpStream { inner, peer: addr })
    }

    pub fn peer_addr(&self) -> io::Result<SocketAddr> {
        Ok(self.peer)
    }
}

async fn connect_inner(url: &str) -> io::Result<DuplexStream> {
    let (_meta, ws) = ws_stream_wasm::WsMeta::connect(url, None)
        .await
        .map_err(|e| other(format!("WebSocket connect to {url} failed: {e}")))?;
    let ws_io = ws.into_io();
    let (client, server) = tokio::io::duplex(64 * 1024);
    wasm_bindgen_futures::spawn_local(async move {
        let mut ws_io = ws_io.compat();
        let mut server = server;
        // Runs until either side closes; dropping both ends tears down the
        // WebSocket and signals EOF to core.
        let _ = tokio::io::copy_bidirectional(&mut ws_io, &mut server).await;
    });
    Ok(client)
}

impl AsyncRead for TcpStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for TcpStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// What [`lookup_host`] accepts. Stand-in for tokio's sealed trait, cut down
/// to the `(host, port)` pairs core resolves.
pub trait ToSocketAddrs {
    #[doc(hidden)]
    fn host_port(&self) -> (&str, u16);
}

impl ToSocketAddrs for (&str, u16) {
    fn host_port(&self) -> (&str, u16) {
        *self
    }
}

impl ToSocketAddrs for (String, u16) {
    fn host_port(&self) -> (&str, u16) {
        (&self.0, self.1)
    }
}

/// Resolves a hostname through the proxy's `/dns/{host}` endpoint.
pub async fn lookup_host(host: impl ToSocketAddrs) -> io::Result<impl Iterator<Item = SocketAddr>> {
    let (host, port) = host.host_port();
    let url = proxy_url("dns", host, None)?;
    let ips = crate::task::spawn(async move { dns_inner(&url).await })
        .await
        .map_err(|_| other("ws dns task dropped"))??;
    Ok(ips.into_iter().map(move |ip| SocketAddr::new(ip, port)))
}

async fn dns_inner(url: &str) -> io::Result<Vec<IpAddr>> {
    let (_meta, mut ws) = ws_stream_wasm::WsMeta::connect(url, None)
        .await
        .map_err(|e| other(format!("WebSocket connect to {url} failed: {e}")))?;
    let message = ws
        .next()
        .await
        .ok_or_else(|| other("no DNS reply from proxy"))?;
    let text = match message {
        ws_stream_wasm::WsMessage::Text(text) => text,
        ws_stream_wasm::WsMessage::Binary(bytes) => {
            String::from_utf8(bytes).map_err(io::Error::other)?
        }
    };
    serde_json::from_str(&text).map_err(|e| other(format!("bad DNS reply: {e}")))
}

/// The parts of a `fetch()` response core uses; unlike JS handles, all Send.
#[derive(Debug)]
pub struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

fn js_str(v: JsValue) -> String {
    format!("{v:?}")
}

/// Runs `fetch()` on the worker's JS event loop.
///
/// Fails if no response arrived within `timeout`; the fetch is aborted
/// via an `AbortController` then (browser `fetch()` has no timeout of
/// its own).
///
/// With `follow_redirects` the browser follows redirects transparently
/// (its default); without it a redirect fails the request
/// (`RequestRedirect::Error`), so request headers such as credentials
/// are never re-sent to a redirect target.
pub async fn fetch(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<String>,
    timeout: Duration,
    follow_redirects: bool,
) -> io::Result<FetchResponse> {
    let method = method.to_string();
    let url = url.to_string();
    let headers: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    crate::task::spawn(async move {
        let controller = web_sys::AbortController::new().ok();
        let result = match crate::time::timeout(
            timeout,
            fetch_inner(
                &method,
                &url,
                &headers,
                body,
                follow_redirects,
                controller.as_ref(),
            ),
        )
        .await
        {
            Ok(result) => result,
            Err(_elapsed) => {
                if let Some(controller) = &controller {
                    controller.abort();
                }
                Err("request timed out".to_string())
            }
        };
        result.map_err(|e| other(format!("fetch {method} {e}")))
    })
    .await
    .map_err(|_| other("fetch task dropped"))?
}

async fn fetch_inner(
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Option<String>,
    follow_redirects: bool,
    controller: Option<&web_sys::AbortController>,
) -> Result<FetchResponse, String> {
    let init = web_sys::RequestInit::new();
    init.set_method(method);
    if !follow_redirects {
        init.set_redirect(web_sys::RequestRedirect::Error);
    }
    if let Some(controller) = controller {
        init.set_signal(Some(&controller.signal()));
    }
    if let Some(body) = &body {
        init.set_body(&JsValue::from_str(body));
    }
    if !headers.is_empty() {
        let js_headers = web_sys::Headers::new().map_err(js_str)?;
        for (name, value) in headers {
            js_headers.append(name, value).map_err(js_str)?;
        }
        init.set_headers(&js_headers);
    }
    // The core always runs in a Web Worker; there is no `window` global.
    let scope: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
    let resp: web_sys::Response = JsFuture::from(scope.fetch_with_str_and_init(url, &init))
        .await
        .map_err(js_str)?
        .unchecked_into();
    let buf = JsFuture::from(resp.array_buffer().map_err(js_str)?)
        .await
        .map_err(js_str)?;
    Ok(FetchResponse {
        status: resp.status(),
        ok: resp.ok(),
        content_type: resp.headers().get("content-type").ok().flatten(),
        body: js_sys::Uint8Array::new(&buf).to_vec(),
    })
}

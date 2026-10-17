//! Browser networking. Browsers cannot open TCP sockets, so:
//!
//! - [`TcpStream`] tunnels a byte stream through a WebSocket proxy that
//!   exposes `/tcp/{ip}/{port}` as a raw tunnel (`packages/ws-tcp-proxy`);
//!   TLS still terminates inside wasm, the proxy only ever relays ciphertext.
//! - [`lookup_host`] resolves through the same proxy's `/dns/{host}` endpoint.
//! - A mail server that tunnels IMAP/SMTP to its own listeners (madmail's
//!   `/mailtunnel`) needs no proxy at all: [`lookup_host`] probes for it once
//!   and hands core a synthetic IP for the host, and [`TcpStream::connect`]
//!   dials that IP through the server's tunnel: a plain binary WebSocket, or
//!   raw-body HTTP long-polling where WebSocket is blocked.
//! - [`fetch`] is HTTP via the browser's `fetch()` (not a tokio API; core's
//!   wasm `net/http` module is a thin adapter over it).
//!
//! JS handles are `!Send`, but core requires `Send` streams and futures. All
//! JS work therefore runs in local tasks ([`crate::task::spawn`]) and only
//! plain Rust values cross back: a `tokio::io::duplex` pair for the socket,
//! a `Vec` for DNS and fetch results.

use std::collections::BTreeMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use futures::StreamExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use tokio_util::compat::FuturesAsyncReadCompatExt;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

use crate::tunnel;

static WS_PROXY_URL: OnceLock<String> = OnceLock::new();

/// Beta switch for the per-server tunnel (Settings → Experimental); on by default.
static SERVER_TUNNEL: AtomicBool = AtomicBool::new(true);
/// Server-tunnel probe results by host, for the worker's lifetime.
static PROBED: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());
/// Synthetic IP → host that tunnels its own IMAP/SMTP (see [`tunnel::synthetic_ip`]).
static TUNNELED: Mutex<BTreeMap<Ipv4Addr, String>> = Mutex::new(BTreeMap::new());

/// Configures the WebSocket proxy base URL (e.g. `ws://localhost:8641`).
/// Must be called before any network operation; subsequent calls are ignored.
pub fn set_ws_proxy_url(url: String) {
    let _ = WS_PROXY_URL.set(url);
}

/// Turns the per-server tunnel off (or back on); off, every host goes
/// through the WebSocket proxy as before. Call before any network operation.
pub fn set_server_tunnel_enabled(enabled: bool) {
    SERVER_TUNNEL.store(enabled, Ordering::Relaxed);
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
        let tunneled = match addr.ip() {
            IpAddr::V4(ip) => TUNNELED.lock().unwrap().get(&ip).cloned(),
            IpAddr::V6(_) => None,
        };
        let inner = match tunneled {
            Some(host) => {
                crate::task::spawn(async move { tunnel_connect(&host, addr.port()).await }).await
            }
            None => {
                let url = proxy_url("tcp", &addr.ip().to_string(), Some(addr.port()))?;
                crate::task::spawn(async move { connect_inner(&url).await }).await
            }
        }
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

/// Does `host` tunnel IMAP/SMTP to itself? `GET /mailtunnel` answers
/// `mailtunnel 1` there, without opening anything.
///
/// A host without the tunnel fails the probe's CORS check (or, for a madmail
/// on a bare IP with a self-signed certificate, its TLS check), which the
/// browser logs to the console and no page code can silence, so each host is
/// probed once per worker; only a probe made while offline is retried. A
/// madmail IP server with a Let's Encrypt IP certificate (`--auto-ip-cert`)
/// passes like any named host.
async fn has_server_tunnel(host: &str) -> bool {
    if !SERVER_TUNNEL.load(Ordering::Relaxed) {
        return false;
    }
    if let Some(&yes) = PROBED.lock().unwrap().get(host) {
        return yes;
    }
    let url = format!("https://{}/mailtunnel", tunnel::url_host(host));
    let yes = crate::task::spawn(async move {
        request("GET", &url, None, Duration::from_secs(5))
            .await
            .is_ok_and(|resp| resp.ok && resp.body.starts_with(b"mailtunnel "))
    })
    .await
    .unwrap_or(false);
    let scope: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
    if yes || scope.navigator().on_line() {
        PROBED.lock().unwrap().insert(host.to_string(), yes);
    }
    yes
}

/// One tunnel to `host` carrying one TCP stream to its `port`: the plain
/// binary WebSocket (the same byte pipe as the proxy's `/tcp/…`), else
/// long-polling.
async fn tunnel_connect(host: &str, port: u16) -> io::Result<DuplexStream> {
    let base = format!("{}/mailtunnel/{port}", tunnel::url_host(host));
    let ws = crate::time::timeout(
        Duration::from_secs(10),
        connect_inner(&format!("wss://{base}")),
    )
    .await;
    match ws {
        Ok(Ok(stream)) => Ok(stream),
        // WebSocket blocked or hanging (proxy, middlebox): long-poll instead.
        _ => polling_tunnel(&format!("https://{base}")).await,
    }
}

/// The long-polling half of the tunnel: `POST` the port URL for a session
/// id, then `GET`/`POST` raw bytes at `…/poll/{id}`; madmail's
/// `mail_tunnel.rs` documents the protocol.
async fn polling_tunnel(open_url: &str) -> io::Result<DuplexStream> {
    let open = request("POST", open_url, None, Duration::from_secs(10)).await?;
    let id = String::from_utf8(open.body).unwrap_or_default();
    if !open.ok || id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(other(format!("mail tunnel refused: HTTP {}", open.status)));
    }
    let url = format!("{}/poll/{id}", open_url.rsplit_once('/').unwrap().0);
    let (client, server) = tokio::io::duplex(64 * 1024);
    let (mut rd, mut wr) = tokio::io::split(server);

    let read_url = url.clone();
    wasm_bindgen_futures::spawn_local(async move {
        // Each GET waits (server side, up to 25 s) for bytes; empty = none yet.
        while let Ok(resp) = request("GET", &read_url, None, Duration::from_secs(40)).await {
            if resp.status != 200 || wr.write_all(&resp.body).await.is_err() {
                break; // 404: the tunnel ended
            }
        }
        // Dropping `wr` signals EOF to core.
    });

    wasm_bindgen_futures::spawn_local(async move {
        let mut buf = vec![0u8; 64 * 1024]; // the server's body limit
        loop {
            let n = match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let body = Some(buf[..n].to_vec());
            let sent = request("POST", &url, body, Duration::from_secs(40)).await;
            if !sent.is_ok_and(|resp| resp.ok) {
                return;
            }
        }
        let close = format!("{url}/close");
        let _ = request("POST", &close, None, Duration::from_secs(10)).await;
    });
    Ok(client)
}

/// One plain HTTP request for the tunnel, any status; must run on the JS
/// thread. A byte body goes out without a content type, which keeps it a
/// CORS "simple" request (no preflight).
async fn request(
    method: &str,
    url: &str,
    body: Option<Vec<u8>>,
    wait: Duration,
) -> io::Result<FetchResponse> {
    let body = body.map(|b| JsValue::from(js_sys::Uint8Array::from(&b[..])));
    crate::time::timeout(wait, fetch_inner(method, url, &[], body, false, None))
        .await
        .map_err(|_| other(format!("mail tunnel {method} timed out")))?
        .map_err(|e| other(format!("mail tunnel {method} {e}")))
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

/// Resolves a hostname through the proxy's `/dns/{host}` endpoint, or to a
/// synthetic IP if the host tunnels its own IMAP/SMTP (no proxy needed).
pub async fn lookup_host(host: impl ToSocketAddrs) -> io::Result<impl Iterator<Item = SocketAddr>> {
    let (host, port) = host.host_port();
    if has_server_tunnel(host).await {
        let ip = tunnel::synthetic_ip(host);
        TUNNELED.lock().unwrap().insert(ip, host.to_string());
        return Ok(vec![SocketAddr::new(ip.into(), port)].into_iter());
    }
    let url = proxy_url("dns", host, None)?;
    let ips = crate::task::spawn(async move { dns_inner(&url).await })
        .await
        .map_err(|_| other("ws dns task dropped"))??;
    Ok(ips
        .into_iter()
        .map(|ip| SocketAddr::new(ip, port))
        .collect::<Vec<_>>()
        .into_iter())
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
                body.as_deref().map(JsValue::from_str),
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
    body: Option<JsValue>,
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
        init.set_body(body);
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

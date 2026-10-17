//! What core does with an IMAP/SMTP host, minus the protocol: resolve it,
//! connect to the first address, write bytes and read the echo back.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn set_server_tunnel(enabled: bool) {
    tokio::net::set_server_tunnel_enabled(enabled);
}

/// Sends `n` bytes to `host:port` and checks they come back unchanged.
#[wasm_bindgen]
pub async fn echo(host: String, port: u16, n: usize) -> Result<String, JsValue> {
    let err = |e: std::io::Error| JsValue::from_str(&e.to_string());
    let addr = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(err)?
        .next()
        .ok_or("no address")?;
    let mut stream = tokio::net::TcpStream::connect(addr).await.map_err(err)?;
    let data: Vec<u8> = (0..n).map(|i| (i % 251) as u8).collect();
    let mut back = vec![0u8; n];
    let (mut rd, mut wr) = tokio::io::split(&mut stream);
    let (sent, got) = tokio::join!(wr.write_all(&data), rd.read_exact(&mut back));
    sent.map_err(err)?;
    got.map_err(err)?;
    if back != data {
        return Err("echo mismatch".into());
    }
    Ok(format!("{addr} echoed {n} bytes"))
}

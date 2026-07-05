//! Compile-compatible network stubs. Browsers have no raw TCP sockets; every
//! operation errors at runtime with `ErrorKind::Unsupported`.
//!
//! M3 replaces `TcpStream::connect` with a WebSocket-tunneled stream.

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub use std::net::ToSocketAddrs;

fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "raw TCP sockets are not available on wasm",
    )
}

#[derive(Debug)]
pub struct TcpStream {
    _priv: (),
}

impl TcpStream {
    pub async fn connect<A: ToSocketAddrs>(_addr: A) -> io::Result<TcpStream> {
        Err(unsupported())
    }

    pub fn set_nodelay(&self, _nodelay: bool) -> io::Result<()> {
        Ok(())
    }

    pub fn peer_addr(&self) -> io::Result<SocketAddr> {
        Err(unsupported())
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        Err(unsupported())
    }
}

impl AsyncRead for TcpStream {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Err(unsupported()))
    }
}

impl AsyncWrite for TcpStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(unsupported()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

pub async fn lookup_host<T: ToSocketAddrs>(_host: T) -> io::Result<std::vec::IntoIter<SocketAddr>> {
    Err(unsupported())
}

//! Bounded reads of a browser Blob without materializing the selected file.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll, ready};

use js_sys::Uint8Array;
use tokio::io::{AsyncRead, ReadBuf};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

const CHUNK_SIZE: u64 = 256 * 1024;

pub struct BrowserFile {
    blob: web_sys::Blob,
    offset: u64,
    pending: Option<JsFuture>,
    chunk: Vec<u8>,
    consumed: usize,
}

impl BrowserFile {
    pub fn new(value: JsValue) -> io::Result<Self> {
        let blob = value.dyn_into().map_err(|_| io::Error::other("backup must be a Blob"))?;
        Ok(Self { blob, offset: 0, pending: None, chunk: Vec::new(), consumed: 0 })
    }

    pub fn size(&self) -> u64 {
        self.blob.size() as u64
    }
}

impl AsyncRead for BrowserFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        dest: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if dest.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.consumed == self.chunk.len() {
            if self.offset == self.size() {
                return Poll::Ready(Ok(()));
            }
            if self.pending.is_none() {
                let end = self.offset.saturating_add(CHUNK_SIZE).min(self.size());
                let slice = self.blob.slice_with_f64_and_f64(self.offset as f64, end as f64)
                    .map_err(|_| io::Error::other("could not slice browser backup"))?;
                self.pending = Some(JsFuture::from(slice.array_buffer()));
            }
            let result = ready!(Pin::new(self.pending.as_mut().unwrap()).poll(cx));
            self.pending = None;
            let result = result.map_err(|_| io::Error::other("could not read browser backup"))?;
            self.chunk = Uint8Array::new(&result).to_vec();
            if self.chunk.is_empty() {
                return Poll::Ready(Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated browser backup")));
            }
            self.offset += self.chunk.len() as u64;
            self.consumed = 0;
        }
        let end = self.consumed + dest.remaining().min(self.chunk.len() - self.consumed);
        dest.put_slice(&self.chunk[self.consumed..end]);
        self.consumed = end;
        Poll::Ready(Ok(()))
    }
}

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Connection-level write-idle enforcement.
//!
//! A response-body timer cannot close a stalled connection: once the peer's
//! receive window fills, Hyper stops polling that body. The timeout therefore
//! belongs on the accepted transport. A pending socket write arms the clock;
//! actual write progress clears it. Expiry drops the socket immediately, which
//! makes Hyper drop its current frame and response body, including admission
//! permits and response-specific encoders retained by that body.

use axum::serve::Listener;
use std::{
    future::Future,
    io::{self, IoSlice},
    net::SocketAddr,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    time::{sleep, Sleep},
};

pub(crate) struct WriteTimeoutListener {
    inner: TcpListener,
    timeout: Option<Duration>,
}

impl WriteTimeoutListener {
    pub(crate) fn new(inner: TcpListener, timeout: Duration) -> Self {
        Self {
            inner,
            timeout: (!timeout.is_zero()).then_some(timeout),
        }
    }
}

impl Listener for WriteTimeoutListener {
    type Io = WriteTimeoutIo<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (stream, address) = <TcpListener as Listener>::accept(&mut self.inner).await;
        (WriteTimeoutIo::new(stream, self.timeout), address)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

pub(crate) struct WriteTimeoutIo<T> {
    inner: Option<T>,
    timeout: Option<Duration>,
    deadline: Option<Pin<Box<Sleep>>>,
}

impl<T> WriteTimeoutIo<T> {
    fn new(inner: T, timeout: Option<Duration>) -> Self {
        Self {
            inner: Some(inner),
            timeout,
            deadline: None,
        }
    }

    fn disconnected() -> io::Error {
        io::Error::new(io::ErrorKind::NotConnected, "connection already closed")
    }

    fn poll_stall(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let Some(timeout) = self.timeout else {
            return Poll::Pending;
        };
        let deadline = self
            .deadline
            .get_or_insert_with(|| Box::pin(sleep(timeout)));
        if deadline.as_mut().poll(cx).is_pending() {
            return Poll::Pending;
        }
        self.inner.take();
        Poll::Ready(Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "socket write made no progress before IFC_STREAM_IDLE_TIMEOUT_SECS",
        )))
    }

    fn note_progress(&mut self) {
        self.deadline = None;
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for WriteTimeoutIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let Some(inner) = self.inner.as_mut() else {
            return Poll::Ready(Err(Self::disconnected()));
        };
        Pin::new(inner).poll_read(cx, buffer)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for WriteTimeoutIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let Some(inner) = self.inner.as_mut() else {
            return Poll::Ready(Err(Self::disconnected()));
        };
        match Pin::new(inner).poll_write(cx, buffer) {
            Poll::Ready(Ok(written)) => {
                if written > 0 || buffer.is_empty() {
                    self.note_progress();
                }
                Poll::Ready(Ok(written))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => self.poll_stall(cx),
        }
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffers: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let all_empty = buffers.iter().all(|buffer| buffer.is_empty());
        let Some(inner) = self.inner.as_mut() else {
            return Poll::Ready(Err(Self::disconnected()));
        };
        match Pin::new(inner).poll_write_vectored(cx, buffers) {
            Poll::Ready(Ok(written)) => {
                if written > 0 || all_empty {
                    self.note_progress();
                }
                Poll::Ready(Ok(written))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => self.poll_stall(cx),
        }
    }

    fn is_write_vectored(&self) -> bool {
        self.inner
            .as_ref()
            .is_some_and(AsyncWrite::is_write_vectored)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(inner) = self.inner.as_mut() else {
            return Poll::Ready(Err(Self::disconnected()));
        };
        match Pin::new(inner).poll_flush(cx) {
            Poll::Ready(result) => {
                self.note_progress();
                Poll::Ready(result)
            }
            Poll::Pending => self.poll_stall(cx).map_ok(|_| ()),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(inner) = self.inner.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        match Pin::new(inner).poll_shutdown(cx) {
            Poll::Ready(result) => {
                self.note_progress();
                Poll::Ready(result)
            }
            Poll::Pending => self.poll_stall(cx).map_ok(|_| ()),
        }
    }
}

#[cfg(test)]
#[path = "write_timeout_tests.rs"]
mod tests;

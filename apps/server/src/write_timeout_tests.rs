// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::WriteTimeoutIo;
use axum::{body::Body, routing::get, Router};
use bytes::Bytes;
use std::{
    convert::Infallible,
    io::{self, IoSlice},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{duplex, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{oneshot, OwnedSemaphorePermit, Semaphore},
    task::yield_now,
    time::{advance, timeout},
};

const IDLE: Duration = Duration::from_secs(30);

struct PendingVectoredWriter;

impl AsyncRead for PendingVectoredWriter {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Pending
    }
}

impl AsyncWrite for PendingVectoredWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        panic!("the wrapper must preserve and use the vectored write path")
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buffers: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Poll::Pending
    }

    fn is_write_vectored(&self) -> bool {
        true
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

struct ResponseReservation {
    _permit: OwnedSemaphorePermit,
    dropped: Option<oneshot::Sender<()>>,
}

impl Drop for ResponseReservation {
    fn drop(&mut self) {
        if let Some(dropped) = self.dropped.take() {
            let _receiver_may_have_closed = dropped.send(());
        }
    }
}

/// Regression for #4582: a pending transport write, unlike producer time,
/// must close the actual connection and return the memory-owning body to Hyper.
#[tokio::test(start_paused = true)]
async fn a_write_with_no_progress_times_out_and_closes_the_transport() {
    let (server, mut peer) = duplex(1);
    let mut server = WriteTimeoutIo::new(server, Some(IDLE));
    server.write_all(b"a").await.unwrap();

    let write = tokio::spawn(async move { server.write_all(b"b").await });
    yield_now().await;
    advance(IDLE).await;

    let error = write.await.unwrap().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(peer.read_u8().await.unwrap(), b'a');
    assert_eq!(peer.read(&mut [0_u8; 1]).await.unwrap(), 0);
}

/// Regression for #4582: no clock is armed merely because a handler is still
/// producing a response; the bound starts only when a socket write is pending.
#[tokio::test(start_paused = true)]
async fn producer_time_without_a_pending_write_is_not_client_idle() {
    let (server, mut peer) = duplex(1);
    let mut server = WriteTimeoutIo::new(server, Some(IDLE));
    advance(IDLE * 10).await;

    server.write_all(b"x").await.unwrap();
    assert_eq!(peer.read_u8().await.unwrap(), b'x');
}

/// Regression for #4582: transport progress renews the idle window, so a slow
/// but draining peer is not disconnected based on total response duration.
#[tokio::test(start_paused = true)]
async fn successful_write_progress_renews_the_idle_window() {
    let (server, mut peer) = duplex(1);
    let mut server = WriteTimeoutIo::new(server, Some(IDLE));
    server.write_all(b"a").await.unwrap();

    let task = tokio::spawn(async move {
        server.write_all(b"b").await?;
        server.write_all(b"c").await?;
        Ok::<_, io::Error>(server)
    });
    yield_now().await;
    advance(IDLE - Duration::from_secs(1)).await;
    assert!(!task.is_finished());

    assert_eq!(peer.read_u8().await.unwrap(), b'a');
    yield_now().await;
    advance(IDLE - Duration::from_secs(1)).await;
    assert!(
        !task.is_finished(),
        "the first byte of progress must renew the window"
    );

    assert_eq!(peer.read_u8().await.unwrap(), b'b');
    assert!(timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    assert_eq!(peer.read_u8().await.unwrap(), b'c');
}

/// Regression for #4582: zero disables the write-idle bound entirely.
#[tokio::test(start_paused = true)]
async fn zero_timeout_keeps_a_blocked_write_pending() {
    let (server, _peer) = duplex(1);
    let mut server = WriteTimeoutIo::new(server, None);
    server.write_all(b"a").await.unwrap();
    let task = tokio::spawn(async move { server.write_all(b"b").await });
    yield_now().await;
    advance(IDLE * 10).await;
    assert!(!task.is_finished());
    task.abort();
}

/// Regression for #4624 review: preserve scatter/gather support so Hyper does
/// not flatten large response chunks, while enforcing the same idle deadline.
#[tokio::test(start_paused = true)]
async fn vectored_writes_preserve_capability_and_the_idle_bound() {
    let mut writer = WriteTimeoutIo::new(PendingVectoredWriter, Some(IDLE));
    assert!(writer.is_write_vectored());

    let write = tokio::spawn(async move {
        let buffers = [IoSlice::new(b"a"), IoSlice::new(b"b")];
        writer.write_vectored(&buffers).await
    });
    yield_now().await;
    advance(IDLE).await;

    let error = write.await.unwrap().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
}

/// Regression for #4582 at the real Axum/Hyper boundary: once an unread peer
/// fills the socket, expiry must drop the response body and return the resource
/// it owns. A body-local watchdog cannot make this happen because Hyper has
/// stopped polling that body; the transport owner can.
#[tokio::test]
async fn stalled_http_peer_drops_the_body_owned_reservation() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let listener = super::WriteTimeoutListener::new(listener, Duration::from_millis(100));

    let admission = Arc::new(Semaphore::new(1));
    let permit = admission.clone().acquire_owned().await.unwrap();
    let (dropped_tx, dropped_rx) = oneshot::channel();
    let reservation = Arc::new(Mutex::new(Some(ResponseReservation {
        _permit: permit,
        dropped: Some(dropped_tx),
    })));
    let app = Router::new().route(
        "/",
        get({
            let reservation = reservation.clone();
            move || {
                let reservation = reservation.clone();
                async move {
                    let guard = reservation.lock().unwrap().take().unwrap();
                    let chunk = Bytes::from(vec![0_u8; 64 * 1024]);
                    let stream = async_stream::stream! {
                        let _guard = guard;
                        loop {
                            yield Ok::<_, Infallible>(chunk.clone());
                        }
                    };
                    Body::from_stream(stream)
                }
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });

    let mut client = TcpStream::connect(address).await.unwrap();
    client
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();

    timeout(Duration::from_secs(10), dropped_rx)
        .await
        .expect("stalled connection must be closed within the idle bound")
        .expect("response body must report its drop");
    assert!(
        admission.try_acquire().is_ok(),
        "body-owned permit must return"
    );

    drop(client);
    server.abort();
}

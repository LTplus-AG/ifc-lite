// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `ifc-lite-desktop-server` — a localhost WebSocket backend that processes IFC
//! files with the **native** geometry engine and streams the result to a plain
//! browser tab. It gives a web app native-speed parsing (real Rayon over one
//! shared heap, no wasm32 4 GB cap) without a desktop install.
//!
//! Protocol: connect to `ws://127.0.0.1:<PORT>/geometry`, send the IFC file as
//! one binary frame, receive binary packed shards + JSON control frames (see
//! [`protocol`]). Bound to loopback only — it is a local utility, not a
//! public service.
//!
//! Build for production with the unwinding profile so a parser panic on a
//! pathological element becomes a per-connection error instead of aborting the
//! whole server (the workspace default `release` is `panic = "abort"`):
//! `cargo run --profile server-release -p ifc-lite-desktop-server`.

mod pool;
mod protocol;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::Response,
    routing::get,
    Router,
};
use bytes::Bytes;
use std::net::SocketAddr;
use tokio::sync::mpsc::unbounded_channel;
use tower_http::cors::CorsLayer;

use protocol::OutMessage;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8082);

    let app = Router::new()
        .route("/health", get(health))
        .route("/geometry", get(ws_handler))
        // The browser frontend runs on a different origin (the production viewer
        // on https://…, the dev server on localhost), so allow cross-origin for
        // the health check and the WS upgrade. `allow_private_network` answers
        // Chrome's Private Network Access preflight (a public/https page → a
        // loopback target needs `Access-Control-Allow-Private-Network: true`) —
        // the production "local helper" topology.
        .layer(CorsLayer::permissive().allow_private_network(true));

    // Loopback only: this is a local accelerator, never a public endpoint.
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    tracing::info!(%addr, "ifc-lite-desktop-server listening (ws://{addr}/geometry)");
    axum::serve(listener, app).await.expect("server error");
}

async fn health() -> &'static str {
    "ok"
}

async fn ws_handler(ws: WebSocketUpgrade) -> Response {
    // tungstenite defaults cap a WS message at 64 MiB / a frame at 16 MiB. The
    // IFC file arrives as one binary frame, so a model larger than 64 MiB — the
    // whole reason this native backend exists — is silently rejected (the client
    // sees a 1006 close). Raise both limits past the largest models we target.
    const MAX_UPLOAD: usize = 2 * 1024 * 1024 * 1024; // 2 GiB
    ws.max_message_size(MAX_UPLOAD)
        .max_frame_size(MAX_UPLOAD)
        .on_upgrade(handle_socket)
}

/// One IFC file per connection: receive the bytes, stream the geometry back.
async fn handle_socket(mut socket: WebSocket) {
    // The client uploads the IFC file as one or more binary frames, then a
    // `{"type":"eof"}` text frame. Chunked upload keeps the browser's peak
    // memory low on large models: a single 722 MB frame forces the tab to hold
    // a full-file copy (on top of its source buffer) just to call `send`, which
    // OOMs the tab. Accumulate the frames; tolerate ping/pong; a graceful close
    // after some data arrived is treated as an implicit eof; bail otherwise.
    let mut content: Vec<u8> = Vec::new();
    let mut want_data_model = false;
    loop {
        match socket.recv().await {
            Some(Ok(Message::Binary(bytes))) => content.extend_from_slice(&bytes),
            Some(Ok(Message::Text(text))) => {
                if text.as_str().contains("\"eof\"") {
                    // The client opts into a streamed data model (so the browser
                    // can skip its own parse + free the source) by putting
                    // `"dataModel":true` on the eof frame. Old clients omit it.
                    want_data_model = text.as_str().contains("\"dataModel\":true");
                    break;
                }
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                if content.is_empty() {
                    return;
                }
                break;
            }
        }
    }

    // The engine is blocking (Rayon); run it off the async runtime and funnel
    // its shards/colour updates through an unbounded channel to this task, which
    // forwards them to the socket in order. The blocking task's sender is the
    // only one kept alive, so the channel closes exactly when processing ends.
    // Shared between the geometry task and the optional data-model task without
    // copying the (possibly 700 MB+) file.
    let content = std::sync::Arc::new(content);
    let (tx, mut rx) = unbounded_channel::<OutMessage>();
    let geom_content = std::sync::Arc::clone(&content);
    let task = tokio::task::spawn_blocking(move || {
        pool::run_on_large_stack(move || {
            protocol::stream_geometry(&geom_content, |msg| {
                // Receiver only goes away if the client disconnected; dropping
                // the message then is correct.
                let _ = tx.send(msg);
            })
        })
    });

    while let Some(out) = rx.recv().await {
        let message = match out {
            OutMessage::Shard(buf) => Message::Binary(Bytes::from(buf)),
            OutMessage::Control(text) => Message::Text(text.into()),
        };
        if socket.send(message).await.is_err() {
            // Client gone — stop forwarding; the blocking task still drains.
            break;
        }
    }

    // Channel drained ⇒ the engine finished. Report stats (or an error if the
    // blocking task panicked — only possible under the unwinding profile).
    let geom_result = task.await;

    // Optional: stream the data model (entities/properties/quantities/spatial/
    // units) as a Parquet payload so the browser can skip its own 12 M-entity
    // parse and free the source buffer. Sent as a `{"type":"dataModel"}` marker
    // then one binary frame, before `done`. Non-fatal on failure — the client
    // falls back to parsing locally.
    if want_data_model && geom_result.is_ok() {
        let dm_content = std::sync::Arc::clone(&content);
        let parquet = tokio::task::spawn_blocking(move || {
            pool::run_on_large_stack(move || {
                let model = ifc_lite_data_model::extract_data_model(dm_content.as_ref());
                ifc_lite_data_model::serialize_data_model_to_parquet(&model)
            })
        })
        .await;
        match parquet {
            Ok(Ok(bytes)) => {
                let _ = socket
                    .send(Message::Text("{\"type\":\"dataModel\"}".to_string().into()))
                    .await;
                let _ = socket.send(Message::Binary(Bytes::from(bytes))).await;
            }
            _ => tracing::warn!("data model extract/serialize failed; client parses locally"),
        }
    }

    let closing = match geom_result {
        Ok(stats) => protocol::done_json(&stats),
        Err(_) => protocol::error_json("geometry processing failed"),
    };
    let _ = socket.send(Message::Text(closing.into())).await;
    let _ = socket.send(Message::Close(None)).await;
}

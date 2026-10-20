// SPDX-License-Identifier: MPL-2.0
//! Errors reported by the native worker client.

#[derive(Debug)]
pub enum WorkerError {
    Io(std::io::Error),
    Protocol(&'static str),
    Kernel {
        status: i32,
        message: String,
    },
    WrongWorker,
    /// Caller input refused before any request reached the worker.
    InvalidArgument(&'static str),
    ResourceLimit(&'static str),
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "geometry worker IO: {error}"),
            Self::Protocol(message) => write!(f, "geometry worker protocol: {message}"),
            Self::Kernel { status, message } => {
                write!(f, "geometry worker status {status}: {message}")
            }
            Self::InvalidArgument(message) => {
                write!(f, "invalid geometry worker argument: {message}")
            }
            Self::WrongWorker => write!(f, "BRep handle belongs to another worker"),
            Self::ResourceLimit(message) => write!(f, "geometry worker resource limit: {message}"),
        }
    }
}
impl std::error::Error for WorkerError {}
impl From<std::io::Error> for WorkerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

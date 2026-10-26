// SPDX-License-Identifier: MPL-2.0
//! Separate source diagnostics from execution stops at analytic boundaries.
#[derive(Debug)]
pub(super) enum WalkError {
    Unsupported(String),
    #[cfg(feature = "retained-runtime")]
    Stopped(crate::resource::ProgramStop),
}
impl From<String> for WalkError {
    fn from(reason: String) -> Self {
        Self::Unsupported(reason)
    }
}
impl From<&str> for WalkError {
    fn from(reason: &str) -> Self {
        Self::Unsupported(reason.into())
    }
}
impl From<crate::Error> for WalkError {
    fn from(error: crate::Error) -> Self {
        #[cfg(feature = "retained-runtime")]
        if let crate::Error::ProgramStopped(stop) = error {
            return Self::Stopped(stop);
        }
        Self::Unsupported(error.to_string())
    }
}
impl WalkError {
    pub(super) fn context(self, context: impl std::fmt::Display) -> Self {
        match self {
            Self::Unsupported(reason) => Self::Unsupported(format!("{context}: {reason}")),
            #[cfg(feature = "retained-runtime")]
            Self::Stopped(stop) => Self::Stopped(stop),
        }
    }
}
impl std::fmt::Display for WalkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(reason) => reason.fmt(f),
            #[cfg(feature = "retained-runtime")]
            Self::Stopped(stop) => stop.fmt(f),
        }
    }
}

impl From<WalkError> for crate::Error {
    fn from(error: WalkError) -> Self {
        match error {
            WalkError::Unsupported(reason) => Self::geometry(reason),
            #[cfg(feature = "retained-runtime")]
            WalkError::Stopped(stop) => Self::ProgramStopped(stop),
        }
    }
}

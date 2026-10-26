// SPDX-License-Identifier: MPL-2.0
use super::BrowserError;
use ifc_lite_processing::element::retained_runtime::RuntimeFault;
impl From<BrowserError> for RuntimeFault {
    fn from(error: BrowserError) -> Self {
        let message = error.to_string();
        match error {
            BrowserError::Kernel { status, .. } => Self::kernel(status, message),
            BrowserError::WrongWorker => Self::retired(message),
            BrowserError::Unqualified(_) => Self::unqualified(message),
            BrowserError::Exhausted => Self::resource_limit(message),
            BrowserError::InvalidLimits | BrowserError::Driver(_) => Self::transport(message),
        }
    }
}

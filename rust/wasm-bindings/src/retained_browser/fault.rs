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
            BrowserError::Exhausted | BrowserError::ResourceLimit(_) => {
                Self::resource_limit(message)
            }
            // InvalidLimits is unreachable after C's numerical-limit admission.
            BrowserError::InvalidLimits | BrowserError::Driver(_) => Self::transport(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Refs #7955: status is evidence, not text parsed by the product controller.
    #[test]
    fn retained_browser_kernel_fault_preserves_status_without_executor_variants() {
        let fault: RuntimeFault = BrowserError::Kernel {
            status: 8,
            message: "copy started".into(),
        }
        .into();
        assert_eq!(
            fault,
            RuntimeFault::kernel(8, "browser kernel 8: copy started")
        );
        assert_eq!(
            RuntimeFault::from(BrowserError::ResourceLimit("mesh budget".into())),
            RuntimeFault::resource_limit("browser resource limit: mesh budget")
        );
        assert_ne!(
            fault,
            RuntimeFault::transport("browser kernel 8: copy started")
        );
        assert_eq!(
            RuntimeFault::from(BrowserError::WrongWorker),
            RuntimeFault::retired("browser worker retired or foreign")
        );
    }
}

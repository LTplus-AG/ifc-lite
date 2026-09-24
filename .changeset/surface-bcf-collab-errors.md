---
"@ifc-lite/viewer": patch
---

BCF and collaboration failures are now shown instead of only being logged (#5600). The BCF panel shows a dismissible error banner when an import or export fails (for example, a corrupt `.bcfzip`), a busy row while a BCF file is being read or written, and an error toast when a viewpoint cannot be captured. In a collaboration room, a failed link revoke, a failed peer removal, and a failed invite-link copy each raise an error toast. The Share dialog's Copy button raises one too. An admin can no longer believe a link was revoked, or a peer removed, when the server refused.

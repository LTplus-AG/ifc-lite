---
'@ifc-lite/bcf-api': patch
'@ifc-lite/viewer': patch
---

BCF server sign-in now finds the API when you enter the bare space or instance URL. BIMcollab Nexus (and Solibri's BCF connector) ask for `https://myspace.bimcollab.com`, but the API is served under `/bcf`, so discovery hit `/2.1/auth` and the connect dialog failed with "BCF request failed (HTTP 404)". An address with no path of its own now falls back to `/bcf`, and a failed request names the URL it was made to.

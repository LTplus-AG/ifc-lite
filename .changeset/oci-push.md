---
"@ifc-lite/oci": minor
---

Add push. `OciClient.pushBlob` uploads a blob (skipped when the registry already holds it) with a POST then a single PUT, `pushEmptyConfig` uploads the OCI empty config, and `pushManifest` puts a manifest by tag or digest, refusing to replace an existing tag (`TAG_EXISTS`, a new error code) unless `allowOverwrite` is set. `buildImageManifest` serializes an image manifest deterministically. Pushes request `pull,push` scope under the same credential rules as pulls, never send an upload to another origin, and verify the digest the registry reports.

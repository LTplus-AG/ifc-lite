---
"@ifc-lite/viewer": patch
---

Gate the source-persisting cache tier on the file's modified time before serving a hit, and store the full-file SHA-256 for both cache tiers so a served hit is background-revalidated (purge + auto-reload on mismatch). Previously only the mesh-only tier was validated: a byte-length-preserving in-place edit (a GUID regeneration, a same-width coordinate correction) is invisible to the spread-sampled cache key, so reopening the edited file silently served the old geometry, properties and source (#4269). The gate is softer than the mesh-only tier's — an unknown mtime still serves, since a source-tier hit is self-consistent and legacy entries lack the field — and the revalidation hash is computed off the main thread, so warm opens gain no main-thread stall.

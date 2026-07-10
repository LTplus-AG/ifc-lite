# @ifc-lite/source-dalux

Dalux Build (Box) file-source provider for ifc-lite.

Implements `FileSourceProvider` from `@ifc-lite/plugin-api` to browse projects,
file areas, folders, and files in Dalux Build, and download IFC revisions
directly into the viewer.

Targets the Dalux **API Identities** auth model (legacy API keys expired
2026-02-28).

## CORS

The Dalux API does not send CORS headers. For browser use, configure a CORS
relay (see `tools/dalux-relay/` for a Cloudflare Worker template) and set the
`proxyUrl` preference. When running in a context without CORS restrictions
(e.g. a Tauri shell or server-side), direct fetch works out of the box.

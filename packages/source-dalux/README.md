# @ifc-lite/source-dalux

Dalux Build (Box) file-source provider for ifc-lite.

Implements `FileSourceProvider` from `@ifc-lite/plugin-api` to browse projects,
file areas, folders, and files in Dalux Build, and download IFC revisions
directly into the viewer.

Uses the published `dalux-build-api` npm client for Dalux route/version
compatibility, while keeping browser requests on the host-provided `fetch`
path.

Targets the Dalux **API Identities** auth model (legacy API keys expired
2026-02-28). The API base URL is fixed at `https://node1.field.dalux.com/service/api`
— it's not company-specific, so there's no base URL setting.

## CORS

The Dalux API does not send CORS headers, so direct browser fetches to it
will fail. Run ifc-lite in a context without CORS restrictions (e.g. a Tauri
desktop shell, or server-side) — there's no in-app CORS relay option.

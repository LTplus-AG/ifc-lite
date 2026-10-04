# Autodesk cloud sources

`@ifc-lite/source-autodesk` integrates Autodesk Forma Data Management (Docs/ACC), Data Exchange resources and Forma Site Design proposal catalogs with IFClite's native source loader.

## Configure the viewer

For static hosting, register an APS **public application with PKCE**, enable the required products, and register exactly:

```
https://your-viewer.example/oauth/autodesk/callback
```

Set `VITE_AUTODESK_CLIENT_ID` at viewer build time, or enter the public application ID in Autodesk source settings. Never put a client secret in a `VITE_` variable or browser preference. The account administrator must authorize the application in Custom Integrations; user sign-in alone does not grant project access. The provider requests `data:read user-profile:read` and stores tokens only in memory. Reloading a static viewer requires signing in again.

For hosted sessions, set `VITE_AUTODESK_HOSTED=true`, deploy [the Autodesk service](../../apps/autodesk-service/README.md) and reverse-proxy `/api/autodesk/*` on the viewer's origin. Register the service callback rather than the static callback. No end-user application ID entry is needed. The browser never receives Autodesk tokens.

Both modes use one connection, verified account identity, PKCE, cryptographic state, explicit cancellation, a BroadcastChannel callback compatible with COOP, and a same-tab fallback when popups are blocked. Disconnect preserves models already loaded in memory.

## Browse and load

Open **Cloud sources → Autodesk Forma / Data Exchange → Sign in**. Browse projects by account, then choose Files or Data Exchanges. Folders page incrementally; unsupported authoring files show the reason they cannot load. IFC, IFCX/IFC5 and GLB file artifacts use the normal viewer loader. Every download pins a version and verifies version ownership before resolving its storage. Source updates also pin their listing version.

For Site Design, paste a documented Forma link containing `siteId` or `/sites/<id>` into the project entry. The `.com` / `.eu` host selects US / EMEA. Linked sites are remembered per signed-in account. Site discovery is link-driven; this does not claim to enumerate every accessible site. Documented ACC Docs project/folder links resolve through the account’s accessible projects. Proposal resource names remain distinct from generated `.ifcx` filenames.

Hub discovery reads Autodesk's documented `attributes.region` and routes subsequent requests to that region. This release supports US and EMEA hubs; other regional hubs report an explicit unsupported-region error rather than being sent to US.

## Native generated artifacts

Data Exchanges and Site Design proposals are **not IFC files**. Their rows are unavailable until the hosted service advertises an installed native artifact adapter. A metadata catalog or Autodesk Viewer derivative is not a native import. The service verifies adapter revision and format, and enforces session ownership and a byte limit. Conversion adapters must preserve geometry, properties, transforms, units and source identity for the selected snapshot and must report fidelity limitations.

The hosted service includes a Rust immutable Forma snapshot converter and a Windows .NET 8 Autodesk SDK exchange worker. Configure their executable paths or the authenticated remote Windows worker as described in [the service guide](../../apps/autodesk-service/README.md). Files and proposals support explicit historical version selection. Whole-exchange IFC export supports the current version only; the worker checks Docs version and exchange snapshot before/after export and rejects a changed source. Proposal meshes preserve occurrences, geometry, placement, color/opacity and source properties; the details panel identifies appearance/overlay limitations.

No live Autodesk account or import fidelity was verified during local implementation. Tests exercise decoded upstream-shaped fixtures and session/security invariants.

# @ifc-lite/a2ui

A2UI v1.0 catalog, entity references and result-surface builders for IFC models.

```bash
npm install @ifc-lite/a2ui
```

- `@ifc-lite/a2ui` exposes `buildSurface`, the query format and the model-aware `modelId:expressId` reference helpers.
  It also holds the catalog ids (`A2UI_PROTOCOL_VERSION`, `IFC_CATALOG_ID`, `A2UI_MIME_TYPE`), the trust policy renderers consult (`IFC_FUNCTION_POLICY`: each function's effect, whether the agent may call it and whether it needs a user gesture; `VIEWER_ACTIONS`; `eventToFollowUp` turns an agent event into a chat follow-up) and the shared chart rules (`resolveMaxGroups`, `foldGroups`, `safeHexColor`).
- `@ifc-lite/a2ui/catalog` exposes the IFC catalog schema and renderer registration.
- `@ifc-lite/a2ui/agent` exposes the agent helpers and `validateIfcMessages`.

See the [A2UI architecture guide](https://github.com/LTplus-AG/ifc-lite/blob/main/docs/architecture/a2ui.md) for renderer and MCP integration.

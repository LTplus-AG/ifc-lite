# MCP for AI Agents

The `@ifc-lite/mcp` package turns any IFC model into a set of tools an LLM agent can call. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) over JSON-RPC, so agents like Claude Code, Claude Desktop, Cursor, Windsurf, Goose, and Zed can query, validate, edit, and visualize real building models directly, no browser and no bespoke integration required. For a BIM audience: it is the same query, geometry, clash, IDS, BCF, and export capabilities you get from the [CLI](cli.md), exposed as agent-callable tools with a permission model on top.

The server bundles the same headless kernel the [CLI](cli.md) and [server](server.md) use, and can optionally drive the WebGL viewer so an agent paints results into a live 3D scene.

## Quickstart

### stdio (local agents)

The default transport is stdio, the mode Claude Desktop and Cursor expect. Pass one or more IFC files as positional arguments and they are preloaded into the model registry:

```bash
# Single model over stdio
ifc-lite mcp ./model.ifc

# Read-only (mutation tools are hidden, not just refused)
ifc-lite mcp ./model.ifc --read-only

# Federate several files into one session
ifc-lite mcp ./arch.ifc ./struct.ifc ./mep.ifc

# Also open the WebGL viewer at startup
ifc-lite mcp ./model.ifc --viewer
```

You can also invoke the package directly with `npx @ifc-lite/mcp ./model.ifc`. Both entry points share the same runtime and flags.

### HTTP (remote agents)

The Streamable HTTP transport serves remote agents:

```bash
ifc-lite mcp ./model.ifc --transport http --port 8765 --token $API_TOKEN
```

!!! warning "HTTP sessions start with an empty registry"
    In `--transport http` mode the positional files are **not** preloaded. Every
    HTTP session gets its own fresh, empty model registry. The agent loads a
    model into its session with the `model_load` tool, which needs `mutate`
    scope, so it is hidden under `--read-only`. Only the default `stdio`
    transport preloads the files you pass on the command line. This isolation is
    deliberate: two sessions that load different files which derive the same
    internal id never alias each other's state.

    A corollary: `--read-only` combined with `--transport http` produces
    sessions that have no way to load a model at all (the registry starts
    empty and `model_load` is hidden). For read-only serving of preloaded
    files, use the `stdio` transport.

By default the server binds `127.0.0.1`. Binding a non-loopback host requires either a `--token` (which becomes the bearer token for full scope) or the `--insecure` flag for development only. The token travels as a plaintext `Authorization` header: the CLI itself serves plain HTTP, so any non-loopback deployment must sit behind a TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer), or the bearer token is readable by anyone on the network path.

### Flags

| Flag | Description |
|------|-------------|
| `--transport <t>` | `stdio` (default) or `http` |
| `--port <N>` | HTTP port (default 8765) |
| `--host <h>` | HTTP host (default 127.0.0.1; non-loopback requires `--token` or `--insecure`) |
| `--token <bearer>` | HTTP bearer token that maps to full scope |
| `--insecure` | Allow a non-loopback bind without a token (development only) |
| `--read-only` | Hide mutation tools |
| `--bsdd <url>` | Override the bSDD endpoint |
| `--allow <path>` | Restrict file-system access (repeatable) |
| `--viewer` | Auto-open the 3D viewer |
| `--viewer-port <N>` | Preferred viewer port (0 = auto) |
| `--open` | Auto-open the viewer **and** open its URL in the browser |

## Scopes and permissions

Every tool declares the scope a caller needs. At `tools/list` time the server filters the advertised set by the session's scope, so an agent never even sees a tool it is not allowed to call, which keeps it from attempting a forbidden operation.

| Scope | Grants |
|-------|--------|
| `read` | Discovery, query, geometry metrics, viewer reads |
| `validate` | IDS validation, model audit |
| `export` | Data and geometry export |
| `mutate` | Property/attribute edits, entity create/delete, model load/save |
| `admin` | All of the above |

Two presets ship out of the box:

- **Full access** (`read`, `validate`, `mutate`, `export`, `admin`) is the default.
- **Read-only** (`read`, `validate`, `export`) is what `--read-only` selects; it omits `mutate`.

A scope can also carry an optional `modelIds` allowlist to restrict a session to specific models.

## What the server exposes

Tools are grouped by capability. Everything below is registered in the default tool registry; the handful of tools that are declared but not yet implemented are called out as **planned**.

| Category | Tools |
|----------|-------|
| Discovery | `model_info`, `model_list`, `model_load`, `model_unload`, `schema_describe` |
| Query | `query_entities`, `count_entities`, `get_entity`, `get_entities_bulk`, `spatial_hierarchy`, `containment_chain`, `relationships`, `properties_unique`, `materials_list`, `classifications_list`, `georeferencing`, `units` |
| Geometry | `geometry_bbox`, `geometry_volume`, `geometry_area`, `geometry_get` *(planned)*, `raycast` *(planned)* |
| Clash | `clash_check`, `clash_matrix` |
| Validation | `ids_validate`, `ids_explain`, `model_audit`, `gherkin_check` *(planned)* |
| Mutation | `entity_set_property`, `entity_delete_property`, `entity_set_attribute`, `entity_create`, `entity_delete`, `mutation_batch`, `mutation_undo`, `mutation_diff`, `model_save` |
| BCF | `bcf_topic_list`, `bcf_topic_create`, `bcf_topic_update`, `bcf_topic_close`, `bcf_viewpoint_create`, `bcf_export` |
| bSDD | `bsdd_search`, `bsdd_class`, `bsdd_property_sets`, `bsdd_match` |
| Diff | `model_diff`, `quantity_diff` |
| Export | `export_ifc`, `export_csv`, `export_json`, `export_glb`, `export_obj`, `export_ifcx`, `export_pdf_report` *(planned)* |
| Viewer | `viewer_ask`, `viewer_open`, `viewer_close`, `viewer_status`, `viewer_colorize`, `viewer_isolate`, `viewer_hide`, `viewer_show`, `viewer_reset`, `viewer_fly_to`, `viewer_set_section`, `viewer_clear_section`, `viewer_color_by_storey`, `viewer_color_by_property`, `viewer_get_selection`, `viewer_wait_for_selection`, `viewer_describe_selection` |

!!! note "Planned tools return a clean error"
    `geometry_get`, `raycast`, `gherkin_check`, and `export_pdf_report` are
    registered so agents can discover them, but they currently return an
    `UNSUPPORTED_OPERATION` result rather than data. Mesh geometry (`geometry_get`)
    and `raycast` need the WASM geometry pipeline; `gherkin_check` awaits the bSI
    Gherkin grammar; `export_pdf_report` is slated for a later release.

### Resources

Live model state is exposed as MCP resources under the `ifc-lite://` URI scheme, so an agent can read current state without a tool round-trip:

```text
ifc-lite://server/manifest
ifc-lite://model/{model_id}/manifest
ifc-lite://model/{model_id}/entity/{global_id}
ifc-lite://model/{model_id}/spatial-tree
ifc-lite://model/{model_id}/materials
ifc-lite://model/{model_id}/property-sets
ifc-lite://viewer/status            (open/closed, port, client count)
ifc-lite://viewer/selection         (live; supports resources/subscribe for push updates)
```

### Prompts

The server ships pre-baked prompts that encode BIM expertise, so an agent can run a whole workflow from one prompt: `audit_model`, `find_fire_rated_doors`, `generate_bcf_from_ids`, `compare_versions`, `space_program_check`, `clash_review`, `prop_quality_pass`, `migrate_to_ifcx`, `visual_audit`, `interactive_property_inspect`, and `visualize_query`.

## Live 3D viewer

When the viewer is open, every viewer-touching tool drives the live scene, and any element the user clicks in the browser flows back to the agent. The intended etiquette is:

1. Call `viewer_ask` with a `reason`; it returns suggested wording so the agent can ask the user for permission.
2. After the user agrees, call `viewer_open`; the result includes the URL to share.
3. Drive the visualization with `viewer_colorize`, `viewer_color_by_property`, `viewer_isolate`, `viewer_fly_to`, `viewer_set_section`, and friends.
4. Subscribe to `ifc-lite://viewer/selection` to be notified on each pick. `viewer_get_selection` reads the latest pick; `viewer_wait_for_selection` blocks until the next click.
5. `viewer_close` when done.

## Wiring it into a client

=== "Claude Code"

    Register the server with the `claude mcp add` command:

    ```bash
    claude mcp add ifc-lite -- npx -y @ifc-lite/mcp /abs/path/to/model.ifc
    ```

    Or commit a project-scoped `.mcp.json` so the whole team shares it:

    ```json
    {
      "mcpServers": {
        "ifc-lite": {
          "command": "npx",
          "args": ["-y", "@ifc-lite/mcp", "/abs/path/to/model.ifc"]
        }
      }
    }
    ```

=== "Claude Desktop"

    Add the server to `claude_desktop_config.json`:

    ```json
    {
      "mcpServers": {
        "ifc-lite": {
          "command": "npx",
          "args": ["-y", "@ifc-lite/mcp", "/abs/path/to/model.ifc"]
        }
      }
    }
    ```

    Restart Claude Desktop and the ifc-lite tools appear in the tool picker.

=== "Streamable HTTP client"

    Start the server over HTTP, then point any MCP-aware Streamable HTTP client
    at it with the bearer token:

    ```bash
    ifc-lite mcp ./model.ifc --transport http --port 8765 --token my-secret
    ```

    ```
    Endpoint:   http://127.0.0.1:8765
    Header:     Authorization: Bearer my-secret
    ```

    Remember to call `model_load` first: an HTTP session starts empty.

Cursor, Windsurf, Goose, and Zed all accept the same `npx @ifc-lite/mcp <file>` stdio command.

## Errors that keep the agent in the loop

Domain errors come back inside the tool result with `isError: true` and a stable `structuredContent.code`, rather than aborting the JSON-RPC call. That keeps the model reasoning instead of failing the chain:

```jsonc
{
  "isError": true,
  "content": [{ "type": "text", "text": "Entity not found in model 'arch'" }],
  "structuredContent": {
    "code": "ENTITY_NOT_FOUND",
    "details": { "model_id": "arch", "express_id": 42 },
    "hint": "Use query_entities to discover valid IDs."
  }
}
```

## Programmatic embedding

For a Tauri, Electron, or Node host, build a server and wire it to a transport directly. The public surface is exported from `@ifc-lite/mcp`:

```ts
import {
  createMCPServer,
  StdioTransport,
  loadIfcModel,
  InMemoryModelRegistry,
} from '@ifc-lite/mcp';

const registry = new InMemoryModelRegistry();
registry.add(await loadIfcModel('./model.ifc'));

const server = createMCPServer({ version: '0.1.0', registry });
const transport = new StdioTransport();
await transport.connect(server);
```

For an in-process host (no child process, no sockets), use `InProcessTransport` and send JSON-RPC envelopes directly:

```ts
import { InProcessTransport } from '@ifc-lite/mcp';

const transport = new InProcessTransport();
await transport.connect(server);

const initResp = await transport.send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-05',
    capabilities: {},
    clientInfo: { name: 'host', version: '1' },
  },
});
```

The server negotiates MCP protocol version `2025-11-05` and accepts the neighbouring published revisions, downgrading anything it does not recognize.

## Why agents plus BIM

MCP is the richest integration: stateful sessions, live viewer control, subscriptions, and a permission model. But it is not the only way to give an agent BIM capability. If your agent already runs shell commands, the [CLI](cli.md) is often enough:

- `ifc-lite ask model.ifc "how many walls?"` answers common questions in plain language through a local recipe engine, with no external AI service involved.
- `ifc-lite eval model.ifc "<expr>"` runs arbitrary SDK expressions, and `ifc-lite schema` dumps the full API so an agent can discover it first.

Reach for MCP when you want the model held open across a conversation, the viewer in the loop, or scoped permissions. Reach for the CLI when a one-shot command answers the question. Both share the same kernel, so results are consistent either way.

See the [`@ifc-lite/mcp` README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/mcp) for the complete tool and resource catalogue.

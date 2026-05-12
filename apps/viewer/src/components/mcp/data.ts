/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Static data shared by all three landing-page variants:
 *
 *   • CATALOG          — the auto-generated tool list (typed import of the JSON
 *                        emitted by `node packages/mcp/dist/cli.js --dump-tools`).
 *                        Until that script lands, `mcp-catalog.json` is hand-
 *                        seeded with the real shape of the v0.1 surface so the
 *                        UI is real.
 *   • CATEGORIES       — display order + short blurb per category.
 *   • CLIENTS          — the install-grid targets (Claude Desktop, Cursor,
 *                        Windsurf, VS Code, Goose).
 *   • RECIPES          — copy-pasteable starter prompts.
 *   • makeConfig…      — builds the JSON config snippet & deep-link URL each
 *                        client expects, so the install Dialog is one source
 *                        of truth instead of three.
 */

import catalogJson from '@/generated/mcp-catalog.json';
import type {
  CatalogTool,
  McpCatalog,
  McpClient,
  McpClientId,
  McpRecipe,
  ToolCategory,
} from './types';

export const CATALOG: McpCatalog = catalogJson as McpCatalog;

/**
 * The version we advertise on the page. Read from the catalog if present,
 * else fall back to a sensible default. (Kept here so the three landings
 * agree without re-reading the JSON.)
 */
export const MCP_VERSION = CATALOG.version ?? '0.1.0';

/**
 * Display order. Maps to the "package.json scripts" mental model so users
 * scanning the catalog land on Discovery → Query first (most common entry
 * points), then escalating capability tiers.
 */
export const CATEGORY_ORDER: ToolCategory[] = [
  'Discovery',
  'Query',
  'Geometry',
  'Validation',
  'Mutation',
  'BCF',
  'bSDD',
  'Diff',
  'Export',
  'Viewer',
];

export const CATEGORY_BLURBS: Record<ToolCategory, string> = {
  Discovery: 'Models, schema, what’s loaded.',
  Query: 'Find entities, properties, materials, classifications.',
  Geometry: 'Bounding boxes, volumes, areas — read from quantity sets.',
  Validation: 'IDS specs and a built-in model audit.',
  Mutation: 'Queue property/attribute writes; persist on save.',
  BCF: 'Author and export buildingSMART issues + viewpoints.',
  bSDD: 'Look up canonical class/property metadata.',
  Diff: 'Compare two loaded models — added/removed/changed.',
  Export: 'Dump to .ifc, CSV, JSON, glTF, IFCx, PDF.',
  Viewer: 'Drive the live WebGL viewer; subscribe to user picks.',
};

export const CATEGORY_GLYPHS: Record<ToolCategory, string> = {
  Discovery: '01',
  Query: '02',
  Geometry: '03',
  Validation: '04',
  Mutation: '05',
  BCF: '06',
  bSDD: '07',
  Diff: '08',
  Export: '09',
  Viewer: '10',
};

export function toolsByCategory(): Map<ToolCategory, CatalogTool[]> {
  const map = new Map<ToolCategory, CatalogTool[]>();
  for (const cat of CATEGORY_ORDER) map.set(cat, []);
  for (const tool of CATALOG.tools) {
    const list = map.get(tool.category) ?? [];
    list.push(tool);
    map.set(tool.category, list);
  }
  for (const [cat, list] of map) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    map.set(cat, list);
  }
  return map;
}

// ── install grid ────────────────────────────────────────────────────────────

export const CLIENTS: McpClient[] = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    blurb: 'Drop into the desktop config. Restart, ask Claude.',
    configHint: '~/Library/Application Support/Claude/claude_desktop_config.json',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    blurb: 'One-click install via deep link, or paste into mcp.json.',
    deepLinkPrefix: 'cursor://anysphere.cursor-deeplink/mcp/install',
    configHint: '~/.cursor/mcp.json',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    blurb: 'Same shape as Cursor; deep link supported in 1.4+.',
    deepLinkPrefix: 'windsurf://mcp/install',
    configHint: '~/.codeium/windsurf/mcp_config.json',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    blurb: 'GitHub Copilot Chat, agent mode. Adds an MCP entry.',
    deepLinkPrefix: 'vscode:mcp/install',
    configHint: '.vscode/mcp.json (workspace) or settings.json',
  },
  {
    id: 'goose',
    name: 'Goose',
    blurb: 'Block’s open-source agent. CLI install.',
    configHint: '~/.config/goose/profiles.yaml',
  },
];

/** Build the canonical JSON snippet for each client. */
export function makeConfigSnippet(client: McpClientId): string {
  const sample = '/abs/path/to/your/model.ifc';
  switch (client) {
    case 'claude-desktop':
      return JSON.stringify(
        {
          mcpServers: {
            'ifc-lite': {
              command: 'npx',
              args: ['-y', '@ifc-lite/mcp', sample],
            },
          },
        },
        null,
        2,
      );
    case 'cursor':
      return JSON.stringify(
        {
          mcpServers: {
            'ifc-lite': {
              command: 'npx',
              args: ['-y', '@ifc-lite/mcp', sample],
            },
          },
        },
        null,
        2,
      );
    case 'windsurf':
      return JSON.stringify(
        {
          mcpServers: {
            'ifc-lite': {
              command: 'npx',
              args: ['-y', '@ifc-lite/mcp', sample],
            },
          },
        },
        null,
        2,
      );
    case 'vscode':
      return JSON.stringify(
        {
          servers: {
            'ifc-lite': {
              type: 'stdio',
              command: 'npx',
              args: ['-y', '@ifc-lite/mcp', sample],
            },
          },
        },
        null,
        2,
      );
    case 'goose':
      return [
        '# In ~/.config/goose/profiles.yaml',
        'extensions:',
        '  ifc-lite:',
        '    cmd: npx',
        '    args: ["-y", "@ifc-lite/mcp", "/abs/path/to/your/model.ifc"]',
      ].join('\n');
  }
}

/**
 * Build the deep-link URL for clients that support one-click install.
 * Returns null for clients that need manual config.
 */
export function makeDeepLink(client: McpClientId): string | null {
  const c = CLIENTS.find((x) => x.id === client);
  if (!c?.deepLinkPrefix) return null;
  const config = {
    name: 'ifc-lite',
    command: 'npx',
    args: ['-y', '@ifc-lite/mcp'],
  };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(config))));
  return `${c.deepLinkPrefix}?name=ifc-lite&config=${encoded}`;
}

// ── recipes ─────────────────────────────────────────────────────────────────

export const RECIPES: McpRecipe[] = [
  {
    id: 'audit-fire-ratings',
    title: 'Audit fire-rating coverage',
    family: 'audit',
    prompt:
      'Run model_audit, then for every IfcWall and IfcDoor with no FireRating in Pset_WallCommon / Pset_DoorCommon, list the GlobalId and storey. Group by storey.',
    uses: ['model_audit', 'query_entities', 'properties_unique'],
  },
  {
    id: 'visualize-external-walls',
    title: 'Visualize all external walls',
    family: 'visualize',
    prompt:
      'Open the viewer, isolate IfcWall where Pset_WallCommon.IsExternal=true, color them red, frame the camera on the bounds.',
    uses: ['viewer_open', 'viewer_isolate', 'viewer_colorize', 'viewer_fly_to'],
  },
  {
    id: 'validate-ids',
    title: 'Validate against this IDS spec',
    family: 'validate',
    prompt:
      'Validate the model against ./specs/lod350-walls.ids. Summarize the failing specifications and color the offending entities red in the viewer.',
    uses: ['ids_validate', 'ids_explain', 'viewer_colorize'],
  },
  {
    id: 'narrow-doors',
    title: 'BCF every door under 80 cm',
    family: 'author',
    prompt:
      'Find every IfcDoor whose OverallWidth < 0.80m. For each, create a BCF topic with priority=Major and a viewpoint that selects only that door. Export the .bcfzip when done.',
    uses: ['query_entities', 'bcf_topic_create', 'bcf_viewpoint_create', 'bcf_export'],
  },
  {
    id: 'diff-versions',
    title: 'Diff two model revisions',
    family: 'compare',
    prompt:
      'Load arch.v3.ifc as model "v3" and arch.v4.ifc as model "v4". Run model_diff and quantity_diff(IfcWall, Volume). Tell me what walls were added or modified.',
    uses: ['model_load', 'model_diff', 'quantity_diff'],
  },
  {
    id: 'bsdd-properties',
    title: 'Lookup bSDD properties for IfcWall',
    family: 'discover',
    prompt:
      'Use bsdd_property_sets for IfcWall. List every Pset and the canonical property names + datatypes. Highlight any in our model that aren’t in the bSDD spec.',
    uses: ['bsdd_property_sets', 'properties_unique', 'schema_describe'],
  },
  {
    id: 'click-to-inspect',
    title: 'Click to inspect',
    family: 'visualize',
    prompt:
      'Open the viewer. When I click an entity, run viewer_describe_selection and tell me everything: attributes, properties, quantities, classifications, materials.',
    uses: ['viewer_open', 'viewer_wait_for_selection', 'viewer_describe_selection'],
  },
  {
    id: 'space-program',
    title: 'Check the space program',
    family: 'audit',
    prompt:
      'Group IfcSpace by storey, sum the area, and tell me which storeys are over/under their target gross area from Pset_SpaceProgram.',
    uses: ['query_entities', 'count_entities', 'geometry_area'],
  },
];

export const FAMILY_ACCENT: Record<McpRecipe['family'], string> = {
  audit: '#d6ff3f',
  visualize: '#7aa2f7',
  validate: '#73daca',
  author: '#ff9e64',
  compare: '#bb9af7',
  discover: '#9ece6a',
};

// ── stats helpers ───────────────────────────────────────────────────────────

export function catalogStats() {
  const tools = CATALOG.tools;
  const byScope = { read: 0, mutate: 0, export: 0 };
  for (const t of tools) byScope[t.scope]++;
  return {
    total: tools.length,
    categories: new Set(tools.map((t) => t.category)).size,
    read: byScope.read,
    mutate: byScope.mutate,
    export: byScope.export,
  };
}

// ── parameter introspection ─────────────────────────────────────────────────
//
// The hand-seeded catalog only carries `type` + `required` for many tools
// (a richer schema dump will land once the CLI flag is wired). The catalog
// page still has to *show* something useful per tool, so we fall back to a
// curated map of parameter descriptions per tool — the agent-facing docs.
// When the live catalog gains real `properties` entries, the page prefers
// those and the fallback only fills in the gaps.

export interface ParamRow {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

const PARAM_FALLBACKS: Record<string, Array<Omit<ParamRow, 'required'>> & { required?: string[] }> = (() => {
  type Row = Omit<ParamRow, 'required'>;
  function pset(includeName = true): Row[] {
    const r: Row[] = [
      { name: 'pset', type: 'string', description: 'Property set name (e.g. "Pset_WallCommon").' },
    ];
    if (includeName) r.push({ name: 'name', type: 'string', description: 'Property name within the pset.' });
    return r;
  }
  function refLocators(): Row[] {
    return [
      { name: 'global_id', type: 'string', description: 'IFC GlobalId. Either this or express_id is required.' },
      { name: 'express_id', type: 'integer', description: 'STEP express id. Either this or global_id is required.' },
      { name: 'model_id', type: 'string', description: 'Optional when only one model is loaded.' },
    ];
  }
  return {
    model_info: [{ name: 'model_id', type: 'string', description: 'Optional; defaults to the only loaded model.' }],
    model_load: [
      { name: 'file_path', type: 'string', description: 'Absolute path to the .ifc file.' },
      { name: 'model_id', type: 'string', description: 'Optional explicit ID; defaults to a slug of the file name.' },
    ],
    model_unload: [{ name: 'model_id', type: 'string', description: 'Model to drop from the registry.' }],
    schema_describe: [
      { name: 'type', type: 'string', description: 'IFC entity name, e.g. "IfcWall".' },
      { name: 'include_inherited', type: 'boolean', description: 'Include attributes from parent classes (default true).' },
    ],
    query_entities: [
      { name: 'type', type: 'string', description: 'IFC entity type filter (e.g. "IfcWall").' },
      { name: 'limit', type: 'integer', description: 'Cap the result count. Default 100.' },
      { name: 'offset', type: 'integer', description: 'Skip this many matches before returning.' },
      { name: 'fields', type: 'string[]', description: 'Whitelist of fields per result (default returns the full shape).' },
      { name: 'in_storey', type: 'string', description: 'GlobalId of an IfcBuildingStorey to scope the query.' },
      { name: 'model_id', type: 'string' },
    ],
    count_entities: [
      { name: 'group_by', type: '"type" | "storey" | "material"' },
      { name: 'type', type: 'string', description: 'Restrict the count to one IFC type.' },
      { name: 'model_id', type: 'string' },
    ],
    get_entity: [...refLocators()],
    get_entities_bulk: [
      { name: 'global_ids', type: 'string[]', description: 'Up to 200 GlobalIds to resolve.' },
      { name: 'model_id', type: 'string' },
    ],
    properties_unique: [
      { name: 'type', type: 'string', description: 'IFC type to scan, e.g. "IfcWall".' },
      ...pset(),
      { name: 'property', type: 'string', description: 'Property name within the pset.' },
      { name: 'model_id', type: 'string' },
    ],
    relationships: refLocators(),
    containment_chain: refLocators(),
    geometry_bbox: refLocators(),
    geometry_volume: refLocators(),
    geometry_area: refLocators(),
    ids_validate: [
      { name: 'ids_path', type: 'string', description: 'Path to the .ids XML file to validate against.' },
      { name: 'model_id', type: 'string' },
    ],
    ids_explain: [{ name: 'ids_path', type: 'string', description: 'Path to the .ids XML to summarise in plain language.' }],
    entity_set_property: [
      ...refLocators(),
      ...pset(),
      { name: 'value', type: 'string | number | boolean', description: 'New value to write.' },
    ],
    entity_delete_property: [...refLocators(), ...pset()],
    entity_set_attribute: [
      ...refLocators(),
      { name: 'attribute', type: '"Name" | "Description" | "ObjectType" | "Tag"' },
      { name: 'value', type: 'string' },
    ],
    entity_create: [
      { name: 'type', type: 'string', description: 'IFC entity to create, e.g. "IfcBuildingElementProxy".' },
      { name: 'attributes', type: 'unknown[]', description: 'Positional STEP attributes (strings, numbers, refs as "#42").' },
      { name: 'model_id', type: 'string' },
    ],
    entity_delete: refLocators(),
    mutation_batch: [
      { name: 'operations', type: '{ tool: string; args: object }[]', description: 'List of sub-tool ops to apply in order.' },
      { name: 'model_id', type: 'string' },
    ],
    mutation_undo: [{ name: 'n', type: 'integer', description: 'Pop the last N pending mutations (default 1).' }],
    model_save: [
      { name: 'file_path', type: 'string', description: 'Output .ifc path.' },
      { name: 'schema', type: '"IFC2X3" | "IFC4" | "IFC4X3"' },
      { name: 'model_id', type: 'string' },
    ],
    bcf_topic_list: [{ name: 'status', type: 'string', description: 'Optional status filter (e.g. "Open").' }],
    bcf_topic_create: [
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'priority', type: 'string' },
      { name: 'assigned_to', type: 'string' },
      { name: 'labels', type: 'string[]' },
    ],
    bcf_topic_update: [
      { name: 'guid', type: 'string', description: 'BCF topic GUID.' },
      { name: 'status', type: 'string' },
      { name: 'priority', type: 'string' },
      { name: 'comment', type: 'string', description: 'Append a comment.' },
    ],
    bcf_topic_close: [{ name: 'guid', type: 'string' }],
    bcf_viewpoint_create: [
      { name: 'guid', type: 'string', description: 'Topic to attach the viewpoint to.' },
      { name: 'selection_global_ids', type: 'string[]' },
    ],
    bcf_export: [{ name: 'file_path', type: 'string', description: 'Output .bcfzip path.' }],
    bsdd_search: [{ name: 'query', type: 'string', description: 'Free-text search across all bSDD dictionaries.' }],
    bsdd_class: [{ name: 'ifc_type', type: 'string', description: 'IFC entity name, e.g. "IfcWall".' }],
    bsdd_property_sets: [{ name: 'ifc_type', type: 'string' }],
    bsdd_match: refLocators(),
    model_diff: [
      { name: 'a', type: 'string', description: 'model_id of the base.' },
      { name: 'b', type: 'string', description: 'model_id of the head.' },
      { name: 'by_entity', type: 'boolean', description: 'Include per-entity GlobalId additions/removals (default true).' },
    ],
    quantity_diff: [
      { name: 'a', type: 'string' },
      { name: 'b', type: 'string' },
      { name: 'type', type: 'string', description: 'Default "IfcWall".' },
      { name: 'quantity', type: 'string', description: 'Default "Volume".' },
      { name: 'group_by', type: '"storey" | "type"' },
    ],
    export_ifc: [
      { name: 'file_path', type: 'string' },
      { name: 'schema', type: '"IFC2X3" | "IFC4" | "IFC4X3"' },
      { name: 'global_ids', type: 'string[]', description: 'Optional GlobalId allowlist; defaults to the whole model.' },
    ],
    export_csv: [
      { name: 'file_path', type: 'string' },
      { name: 'type', type: 'string', description: 'Filter by IFC type. Default: all products.' },
      { name: 'columns', type: 'string[]', description: 'Plain attributes or "Pset_X.Property" / "Qto_X.Quantity" paths.' },
      { name: 'separator', type: 'string', description: 'Default ",".' },
    ],
    export_json: [
      { name: 'file_path', type: 'string' },
      { name: 'type', type: 'string' },
      { name: 'columns', type: 'string[]' },
    ],
    viewer_open: [{ name: 'model_id', type: 'string' }],
    viewer_colorize: [
      { name: 'global_ids', type: 'string[]' },
      { name: 'express_ids', type: 'integer[]' },
      { name: 'type', type: 'string' },
      { name: 'color', type: 'string | [r,g,b] | [r,g,b,a]', description: 'Hex (#ff8800), [0–1] tuple, or named colour.' },
      { name: 'model_id', type: 'string' },
    ],
    viewer_isolate: [
      { name: 'global_ids', type: 'string[]' },
      { name: 'express_ids', type: 'integer[]' },
      { name: 'type', type: 'string' },
      { name: 'model_id', type: 'string' },
    ],
    viewer_hide: [
      { name: 'global_ids', type: 'string[]' },
      { name: 'express_ids', type: 'integer[]' },
      { name: 'type', type: 'string' },
    ],
    viewer_show: [
      { name: 'global_ids', type: 'string[]' },
      { name: 'express_ids', type: 'integer[]' },
      { name: 'type', type: 'string' },
    ],
    viewer_fly_to: [
      { name: 'global_ids', type: 'string[]' },
      { name: 'express_ids', type: 'integer[]' },
    ],
    viewer_set_section: [
      { name: 'axis', type: '"x" | "y" | "z"' },
      { name: 'position', type: 'number', description: 'Section plane offset along the chosen axis.' },
      { name: 'flipped', type: 'boolean' },
      { name: 'enabled', type: 'boolean' },
    ],
    viewer_color_by_property: [
      { name: 'type', type: 'string' },
      { name: 'pset', type: 'string' },
      { name: 'property', type: 'string' },
      { name: 'missing_color', type: 'string', description: 'Colour for entities lacking the property. Default "gray".' },
    ],
    viewer_get_selection: [
      { name: 'include', type: '("attributes"|"properties"|"quantities"|"classifications"|"materials")[]', description: 'Default ["attributes","classifications","materials"].' },
    ],
    viewer_describe_selection: [],
    viewer_wait_for_selection: [
      { name: 'timeout_ms', type: 'integer', description: 'Default 60000.' },
      { name: 'include', type: 'string[]' },
    ],
    viewer_ask: [
      { name: 'reason', type: 'string', description: 'Why the agent wants the viewer open (used in the suggested wording).' },
      { name: 'model_id', type: 'string' },
    ],
  };
})();

/**
 * Build a parameter table for a tool. Merges fields declared on the live
 * `inputSchema.properties` with the curated `PARAM_FALLBACKS` map, so a
 * partially-enriched schema (a few typed fields, no descriptions) still
 * picks up the curated descriptions instead of rendering blank cells.
 *
 * Schema is the source of truth for `type`, `enum`, and `required`; the
 * fallback only fills gaps in `description` and supplies any rows the
 * schema didn't declare at all.
 */
export function paramsFor(tool: CatalogTool): ParamRow[] {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] };
  const required = new Set(schema?.required ?? []);
  const fallback = PARAM_FALLBACKS[tool.name] ?? [];
  const fallbackByName = new Map(fallback.map((row) => [row.name, row]));

  const seen = new Set<string>();
  const rows: ParamRow[] = [];

  if (schema?.properties) {
    for (const [name, def] of Object.entries(schema.properties)) {
      const fb = fallbackByName.get(name);
      const type = def?.enum
        ? def.enum.map((v) => JSON.stringify(v)).join(' | ')
        : (def?.type ?? fb?.type ?? 'unknown');
      rows.push({
        name,
        type,
        required: required.has(name),
        description: def?.description ?? fb?.description,
      });
      seen.add(name);
    }
  }

  // Append fallback-only rows (schemas that haven't enumerated every
  // parameter yet — mostly the v0.5 stubs).
  for (const row of fallback) {
    if (seen.has(row.name)) continue;
    rows.push({ ...row, required: required.has(row.name) });
  }

  return rows;
}

// ── example invocations ─────────────────────────────────────────────────────
//
// One realistic example arg payload per tool. Used by the catalog page to
// show "this is what an agent would actually send" — far more useful than
// dumping the JSON Schema verbatim.

export const EXAMPLES: Record<string, Record<string, unknown>> = {
  model_info: {},
  model_list: {},
  model_load: { file_path: '/abs/path/to/arch.ifc' },
  model_unload: { model_id: 'arch' },
  schema_describe: { type: 'IfcWall' },
  query_entities: { type: 'IfcWall', limit: 25 },
  count_entities: { group_by: 'type' },
  get_entity: { global_id: '1AQAupaRP1txwK1AGiN61V' },
  get_entities_bulk: { global_ids: ['1AQAupaRP1txwK1AGiN61V', '0u4wgLe6n0ABVaiXyikbkA'] },
  spatial_hierarchy: {},
  containment_chain: { global_id: '1AQAupaRP1txwK1AGiN61V' },
  relationships: { global_id: '1AQAupaRP1txwK1AGiN61V' },
  properties_unique: { type: 'IfcWall', pset: 'Pset_WallCommon', property: 'IsExternal' },
  materials_list: {},
  classifications_list: {},
  georeferencing: {},
  units: {},
  geometry_bbox: { global_id: '1AQAupaRP1txwK1AGiN61V' },
  geometry_volume: { global_id: '1AQAupaRP1txwK1AGiN61V' },
  geometry_area: { global_id: '1AQAupaRP1txwK1AGiN61V' },
  model_audit: {},
  ids_validate: { ids_path: './specs/lod350-walls.ids' },
  ids_explain: { ids_path: './specs/lod350-walls.ids' },
  entity_set_property: { global_id: '1AQAupaRP1txwK1AGiN61V', pset: 'Pset_WallCommon', name: 'FireRating', value: 'EI60' },
  entity_delete_property: { global_id: '1AQAupaRP1txwK1AGiN61V', pset: 'Pset_WallCommon', name: 'FireRating' },
  entity_set_attribute: { global_id: '1AQAupaRP1txwK1AGiN61V', attribute: 'Description', value: 'Touched by MCP suite' },
  entity_create: { type: 'IfcBuildingElementProxy', attributes: [] },
  entity_delete: { express_id: 981 },
  mutation_batch: { operations: [{ tool: 'entity_set_property', args: { global_id: '...', pset: 'Pset_WallCommon', name: 'FireRating', value: 'EI60' } }] },
  mutation_diff: {},
  mutation_undo: { n: 1 },
  model_save: { file_path: '/tmp/audited.ifc' },
  bcf_topic_list: {},
  bcf_topic_create: { title: 'Missing fire rating', priority: 'Major' },
  bcf_topic_update: { guid: '7e87d7f4-...', comment: 'Confirmed with the structural team.' },
  bcf_topic_close: { guid: '7e87d7f4-...' },
  bcf_viewpoint_create: { guid: '7e87d7f4-...', selection_global_ids: ['1AQAupaRP1txwK1AGiN61V'] },
  bcf_export: { file_path: '/tmp/issues.bcfzip' },
  bsdd_search: { query: 'wall' },
  bsdd_class: { ifc_type: 'IfcWall' },
  bsdd_property_sets: { ifc_type: 'IfcWall' },
  bsdd_match: { global_id: '1AQAupaRP1txwK1AGiN61V' },
  model_diff: { a: 'arch_v3', b: 'arch_v4' },
  quantity_diff: { a: 'arch_v3', b: 'arch_v4', type: 'IfcWall', quantity: 'Volume' },
  export_ifc: { file_path: '/tmp/audited.ifc' },
  export_csv: { file_path: '/tmp/walls.csv', type: 'IfcWall', columns: ['GlobalId', 'Name', 'Pset_WallCommon.IsExternal'] },
  export_json: { file_path: '/tmp/walls.json', type: 'IfcWall' },
  export_glb: { file_path: '/tmp/scene.glb' },
  export_ifcx: { file_path: '/tmp/scene.ifcx' },
  export_pdf_report: { file_path: '/tmp/audit.pdf' },
  viewer_ask: { reason: 'to highlight failing fire-rated doors' },
  viewer_open: {},
  viewer_close: {},
  viewer_status: {},
  viewer_colorize: { type: 'IfcWall', color: '#d6ff3f' },
  viewer_isolate: { type: 'IfcWall' },
  viewer_hide: { global_ids: ['1AQAupaRP1txwK1AGiN61V'] },
  viewer_show: { global_ids: ['1AQAupaRP1txwK1AGiN61V'] },
  viewer_reset: {},
  viewer_fly_to: { global_ids: ['1AQAupaRP1txwK1AGiN61V'] },
  viewer_set_section: { axis: 'z', position: 1.5 },
  viewer_clear_section: {},
  viewer_color_by_storey: {},
  viewer_color_by_property: { type: 'IfcWall', pset: 'Pset_WallCommon', property: 'IsExternal' },
  viewer_get_selection: { include: ['attributes', 'properties', 'materials'] },
  viewer_describe_selection: {},
  viewer_wait_for_selection: { timeout_ms: 60000 },
};

/** Build the JSON-RPC tools/call envelope for a given tool example. */
export function exampleCall(tool: CatalogTool): string {
  return JSON.stringify(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool.name, arguments: EXAMPLES[tool.name] ?? {} },
    },
    null,
    2,
  );
}

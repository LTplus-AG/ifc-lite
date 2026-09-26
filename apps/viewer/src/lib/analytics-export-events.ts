/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isSdkProperty, type UiSurface } from './analytics-ui-events.js';

/** The initiating UI surface, including exports owned by a workspace panel. */
const PANEL_EXPORT_SURFACES = [
  'mobile', 'context_menu', 'clash_results', 'charts_report', 'document', 'list_results',
  'cost_panel', 'deviation_panel', 'bcf_panel', 'lens_panel', 'zones_panel',
  'appearance_panel', 'flow_panel', 'layer_review', 'layer_evidence', 'location_map',
  'placement_panel', 'drawing_panel', 'ids_panel', 'compare_panel', 'search_panel',
  'load_report', 'extension_panel', 'mcp_playground', 'federation_panel', 'landxml_refusal',
  'script',
] as const;
export type ExportSurface = UiSurface | (typeof PANEL_EXPORT_SURFACES)[number];

const EXPORT_FORMATS = [
  'ifc', 'ifcx', 'ifczip', 'ifc-anonymized', 'zip', 'glb', 'kmz', 'usda', 'hbjson',
  'dfjson', 'csv', 'json', 'png', 'pdf', 'pdf-3d-view', 'xlsx', 'bcfzip', 'dxf',
  'svg', 'html', 'ids', 'iflv', 'xml', 'extension', 'other',
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Only fixed choices, flags, and aggregate counts may accompany an export. */
export interface ExportCompletedProperties {
  format: ExportFormat;
  surface: ExportSurface;
  scope?: 'single' | 'merged';
  color_source?: 'rendering' | 'shading';
  projection_mode?: 'perspective' | 'orthographic';
  render_mode?: 'lines' | 'shaded';
  relation_toggles?: string[];
  changes_only?: boolean;
  visible_only?: boolean;
  include_geometry?: boolean;
  include_metadata?: boolean;
  lit?: boolean;
  section_enabled?: boolean;
  hidden_edges?: boolean;
  scale_stamp?: boolean;
  anonymize_property_sets?: boolean;
  anonymize_names?: boolean;
  anonymize_other_names?: boolean;
  anonymize_guids?: boolean;
  anonymize_root_placement_position?: boolean;
  anonymize_georeferencing?: boolean;
  anonymize_currency?: boolean;
  size_kb?: number;
  scale_factor?: number;
  shading_dpi?: number | null;
  seed_count?: number;
  included_count?: number;
  row_count?: number;
  column_count?: number;
  chart_count?: number;
  page_count?: number;
  snapshot_count?: number;
  block_count?: number;
  unresolved_count?: number;
  table_block_count?: number;
  topic_count?: number;
  model_count?: number;
  change_count?: number;
}

const KEYS: readonly (keyof ExportCompletedProperties)[] = [
  'format', 'surface', 'scope', 'color_source', 'projection_mode', 'render_mode', 'relation_toggles',
  'changes_only', 'visible_only', 'include_geometry', 'include_metadata', 'lit', 'section_enabled',
  'hidden_edges', 'scale_stamp', 'anonymize_property_sets', 'anonymize_names', 'anonymize_other_names',
  'anonymize_guids', 'anonymize_root_placement_position', 'anonymize_georeferencing', 'anonymize_currency',
  'size_kb', 'scale_factor', 'shading_dpi', 'seed_count', 'included_count', 'row_count', 'column_count',
  'chart_count', 'page_count', 'snapshot_count', 'block_count', 'unresolved_count', 'table_block_count',
  'model_count', 'change_count', 'topic_count',
];
const BOOLEAN_KEYS = new Set<string>(KEYS.filter((key) => key.startsWith('anonymize_')).concat([
  'changes_only', 'visible_only', 'include_geometry', 'include_metadata', 'lit', 'section_enabled',
  'hidden_edges', 'scale_stamp',
]));
const ENUMS: Readonly<Record<string, readonly string[]>> = {
  format: EXPORT_FORMATS,
  surface: ['ribbon', 'classic', 'rail', 'palette', 'shortcut', ...PANEL_EXPORT_SURFACES],
  scope: ['single', 'merged'],
  color_source: ['rendering', 'shading'],
  projection_mode: ['perspective', 'orthographic'],
  render_mode: ['lines', 'shaded'],
};
const RELATION_TOGGLES = new Set(['voids', 'fills', 'aggregates', 'type', 'material', 'psets', 'connected']);

/** Runtime allowlist at PostHog's before_send boundary. */
export function scrubExportEvent<T extends { event?: string; properties?: Record<string, unknown> } | null>(event: T): T | null {
  if (event?.event !== 'export_completed' || !event.properties) return event;
  for (const [key, value] of Object.entries(event.properties)) {
    if (isSdkProperty(key)) continue;
    if (!KEYS.includes(key as keyof ExportCompletedProperties)) { delete event.properties[key]; continue; }
    const allowed = ENUMS[key];
    const valid = allowed ? typeof value === 'string' && allowed.includes(value)
      : key === 'relation_toggles' ? Array.isArray(value) && value.every((item) => RELATION_TOGGLES.has(item))
        : BOOLEAN_KEYS.has(key) ? typeof value === 'boolean'
          : value === null && key === 'shading_dpi' ? true
            : typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!valid) delete event.properties[key];
  }
  // A malformed capture is not a completed export with known attribution.
  // Drop it instead of sending an export that violates the 100%-surface contract.
  if (!event.properties.surface || !event.properties.format) return null;
  return event;
}

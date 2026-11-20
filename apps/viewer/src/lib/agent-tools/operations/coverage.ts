/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { TOOL_IDS } from '@/lib/viewport-ui/tool-ids';
import { TOOL_FEATURE, toolFeatureRows } from '@/lib/features/tools';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { viewerOperations } from './registry';
import { panelControlAudits, toolControlAudits, type AuditFamily } from './coverage-audit';
import { clashControlBindings } from './clash-native-inventory';
import { coreControlInventory } from './core-inventory';
import { analyticsControlInventory, analyticsControlBoundaries } from './analytics-inventory';
import { coordinationControlInventory } from './coordination-inventory';
import { authoringControlBindings } from './authoring-inventory';
import { appearanceNativeControlBindings } from './appearance-native-inventory';
import { nativeExportRegistryInventory } from './export-native-inventory';

// native-unsupported: the native viewer has no such control either, so the agent cannot lack it.
type Classification = 'implemented' | 'presentation-only' | 'native-boundary' | 'native-unsupported' | 'unimplemented';
/** grouped: the control names several native controls whose operations are listed together; per-control mapping is not recorded. */
interface Control { control: string; operations: readonly string[]; native_tools?: readonly string[]; classification: Classification; reason?: string; grouped?: true }
const grouped = (row: Control): Control => ({ ...row, grouped: true });
interface Inventory { owner: string; family: AuditFamily; controls: readonly Control[]; notes: readonly string[]; gaps: readonly string[] }
function classify(status: string): Classification {
  if (status === 'implemented') return status;
  if (status === 'presentation-only' || status === 'presentation-gesture') return 'presentation-only';
  if (['human-observation', 'native-input-boundary', 'native-confirmation-boundary', 'native-user-gesture-boundary',
    'native-input-or-provider-boundary', 'native-credential-and-publication-boundary', 'extension-host-boundary'].includes(status)) return 'native-boundary';
  return 'unimplemented';
}
function control(control: string, operations: readonly string[], classification: Classification = 'implemented', reason?: string, native_tools?: readonly string[]): Control {
  return { control, operations, classification, ...(native_tools?.length ? { native_tools } : {}), ...(reason ? { reason } : {}) };
}
/** Inventories contain concrete controls, their shared native bindings and real boundaries.
 * Notes describe existing native limits; only actual missing bindings enter gaps. */
export function operationControlInventory(): Inventory[] {
  return [
    ...coreControlInventory.map(row => ({ owner: row.owner, family: 'core' as const, controls: row.controls.map(item => control(item.control, item.operations,
      'classification' in item ? classify(item.classification) : 'implemented', 'reason' in item ? item.reason : undefined)), notes: row.notes, gaps: [] })),
    // Presentation-only and unsupported controls are classified controls, not notes, so callers can find their boundaries.
    ...analyticsControlInventory.map(row => ({ owner: row.panel, family: 'analytics' as const, controls: [
      ...row.controls.map(item => control(item.control, item.operations)),
      ...('presentationOnly' in row ? row.presentationOnly : []).map(item => control(item, [], 'presentation-only')),
      ...('nativeUnsupported' in row ? row.nativeUnsupported : []).map(item => control(item, [], 'native-unsupported', item)),
    ], notes: row.notes, gaps: [] })),
    ...analyticsControlBoundaries.map(row => ({ owner: row.panel, family: 'analytics' as const,
      controls: [control(row.control, [], classify(row.classification), row.native)], notes: [], gaps: [] })),
    ...coordinationControlInventory.map(row => ({ owner: row.owner, family: 'coordination' as const,
      controls: [grouped(control(row.implemented.join('; '), row.operations)),
        // The manual approvals and presentation a workflow keeps native are controls of their own.
        ...('hostBoundary' in row ? [control(String(row.hostBoundary), [], 'native-boundary', String(row.hostBoundary))] : []),
        ...('presentationOnly' in row ? [control(String(row.presentationOnly), [], 'presentation-only')] : [])],
      notes: (['equivalentControls', 'sourceWriteBack'] as const).flatMap(key => key in row ? [String((row as Record<string, unknown>)[key])] : []), gaps: row.outstanding })),
    ...authoringControlBindings.map(row => ({ owner: row.owner === 'ids' ? 'idsStudio' : row.owner, family: 'authoring' as const,
      controls: [grouped(control(row.controls.join('; '), row.operations, classify(row.status), row.reason))], notes: [], gaps: [] })),
    ...clashControlBindings.map(row => ({ owner: 'clash', family: 'clash' as const,
      controls: [grouped(control(row.controls.join('; '), row.operations, classify(row.status), 'boundary' in row ? row.boundary : undefined))], notes: [], gaps: [] })),
    ...appearanceNativeControlBindings.map(row => ({ owner: 'appearance', family: 'appearance' as const,
      controls: [grouped(control(row.controls.join('; '), row.operations, classify(row.status), row.boundary))], notes: [], gaps: [] })),
  ];
}
function missingControls(controls: readonly Control[], registered: ReadonlySet<string>): string[] {
  return controls.flatMap(row => row.classification === 'unimplemented' ? [`Unclassified control: ${row.control}`]
    : row.classification === 'implemented' && !row.operations.length && !row.native_tools?.length ? [`Missing native binding: ${row.control}`]
    : row.operations.filter(id => !registered.has(id)).map(id => `Control refers to an unregistered operation: ${id}`));
}
export function viewerOperationCoverage() {
  const operations = viewerOperations(), registered = new Set(operations.map(row => row.id)), inventory = operationControlInventory();
  const ids = (prefixes: readonly string[]) => operations.filter(row => prefixes.some(prefix => row.id.startsWith(prefix))).map(row => row.id);
  const panels = WORKSPACE_PANELS.map(({ id }) => {
    const audit = panelControlAudits[id], rows = inventory.filter(row => row.owner === id);
    const controls = rows.flatMap(row => row.controls);
    // The reverse check: an operation registered under this panel must be bound to an audited control.
    const audited = new Set(controls.flatMap(row => row.operations));
    const unaudited = operations.filter(row => row.owner === id && !audited.has(row.id)).map(row => `Operation not in the control audit: ${row.id}`);
    const gaps = [...rows.flatMap(row => row.gaps), ...missingControls(controls, registered), ...unaudited];
    if (!controls.length || audit.some(family => !rows.some(row => row.family === family && row.controls.length))) gaps.push('Missing audited control inventory.');
    return { id, complete: gaps.length === 0, audit_families: audit, controls, notes: rows.flatMap(row => row.notes),
      implemented: operations.filter(row => row.owner === id).map(row => row.id), gaps };
  });
  // Every registered activeTool, so a new tool is an explicit gap until audited.
  const toolIds = [...new Set([...TOOL_IDS.filter(id => id !== 'none'), ...Object.keys(TOOL_FEATURE), ...Object.keys(toolFeatureRows(''))])];
  const tools = toolIds.map(id => {
    const audit = toolControlAudits[id];
    const controls = audit ? [control(audit.controls, audit.operations, 'implemented', audit.notes, audit.native_tools)] : [];
    const gaps = audit ? missingControls(controls, registered) : ['New native tool needs a concrete control audit.'];
    return { id, complete: gaps.length === 0, controls, implemented: audit?.operations ?? [], native_tools: audit?.native_tools ?? [], notes: audit?.notes ? [audit.notes] : [], gaps };
  });
  const exports = nativeExportRegistryInventory.map(row => {
    const status = 'classification' in row ? classify(row.classification) : 'implemented';
    const controls = [control('controls' in row ? row.controls.join('; ') : row.registry_id, row.operations, status, 'native' in row ? row.native : undefined)];
    const gaps = missingControls(controls, registered);
    return { id: row.registry_id, complete: gaps.length === 0, controls, gaps };
  });
  // Non-panel families list operations by prefix; each must still be bound to an audited control somewhere.
  const audited = new Set([...panels, ...tools, ...exports].flatMap(row => row.controls.flatMap(control => control.operations)));
  const withGaps = <T extends { implemented?: readonly string[]; controls?: readonly Control[] }>(row: T) => {
    const own = new Set(row.controls?.flatMap(control => control.operations) ?? []);
    const gaps = (row.implemented ?? []).filter(id => !audited.has(id) && !own.has(id)).map(id => `Operation not in the control audit: ${id}`);
    return { ...row, complete: gaps.length === 0, gaps };
  };
  const nonPanel = [
      { id: 'viewport', controls: inventory.filter(row => row.owner === 'viewport').flatMap(row => row.controls) },
      { id: 'preferences', implemented: ids(['preferences.']), controls: inventory.filter(row => row.owner === 'preferences').flatMap(row => row.controls), notes: inventory.filter(row => row.owner === 'preferences').flatMap(row => row.notes) },
      { id: 'search', implemented: ids(['filters.', 'fields.']), controls: inventory.filter(row => row.owner === 'search').flatMap(row => row.controls) },
      { id: 'palette', native_tools: ['viewer_commands', 'viewer_command_run'], notes: ['Mounted native command contributions and current prerequisites remain the source of truth.'] },
      { id: 'file-export', native_tools: ['viewer_artifacts', 'viewer_artifact_read', 'viewer_artifact_download', 'viewer_artifact_delete'], implemented: ids(['exports.']), registry: exports },
      { id: 'contextual-entity', implemented: ids(['selection.', 'visibility.', 'basket.', 'authoring.', 'properties.']) },
      { id: 'tours-mobile', implemented: ids(['presentation.', 'camera.']), notes: ['Pointer/held-key/drag/resize feedback is presentation; native pose, timed path and palette controls expose domain effects.'] },
      { id: 'runtime-extensions', implemented: ids(['extensions.', 'flavors.']), notes: ['Installed native grants and owner-qualified live host invocation remain authoritative; arbitrary third-party component internals are outside the built-in inventory.'] },
  ].map(withGaps);
  // Every registered operation is bound to some audited control, whatever row owns it.
  const bound = new Set([...audited, ...nonPanel.flatMap(row => row.controls?.flatMap(control => control.operations) ?? [])]);
  const unbound = operations.filter(row => !bound.has(row.id)).map(row => row.id);
  return {
    version: 2, scope: 'audited built-in domain controls, numeric gesture equivalents and native host boundaries',
    complete: panels.every(row => row.complete) && tools.every(row => row.complete) && exports.every(row => row.complete) && nonPanel.every(row => row.complete) && unbound.length === 0,
    unbound_operations: unbound,
    all_controls_automatable: false, panel_count: panels.length, operation_count: operations.length, panels, tools, exports,
    non_panel: nonPanel,
    human_only: [
      { id: 'browser-file-password-input', reason: 'Native local-file selection, encrypted-document passwords and OAuth prompts retain their existing browser/credential host interaction.' },
      { id: 'publication-and-seed-consent', reason: 'Native concrete publication review, room model-seed consent and new extension capability review require their existing explicit approval.' },
      { id: 'browser-print', reason: 'Printer selection and print confirmation belong to the native browser/OS dialog; native PDF artifacts are independently available.' },
      { id: 'physical-observation', reason: 'Software records supplied Manual checklist evidence; it cannot establish that an external physical inspection happened.' },
    ],
    limitations: ['Completeness describes the explicit built-in control audit, not unrestricted DOM automation or future third-party UI.',
      'Native geometry/source/role/feature refusals remain authoritative. Some services require a mounted renderer or editor history.',
      'Native admitted non-cancellable work drains to an actual outcome; dispatch is distinguished from completion.',
      'Real GPU-success witnesses require renderer/scan fixtures; source/refusal tests do not fabricate those witnesses.'],
  };
}

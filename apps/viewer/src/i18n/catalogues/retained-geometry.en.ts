/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Retained geometry kernel (#7955 M2): the viewport chip, the Retained
 * geometry panel, the kernel setting, status-bar phases, scope refusals and
 * the shape-only reason on refused tools. A lazy catalogue registered by the
 * retained module (`lib/retained/index.ts`), which only a
 * `VITE_RETAINED_GEOMETRY=on` build contains — the default build ships none
 * of these strings.
 */
export const retainedGeometryEn = {
  'retainedGeometry.shapeOnlyReason': 'Unavailable on a Retained · shape-only model: its meshes have no openings, layers or appearance. Reload it with the exact kernel to use this.',

  'retainedGeometry.chip.starting': 'Retained · shape-only · starting engine',
  'retainedGeometry.chip.running': 'Retained · shape-only · {done}/{candidates} products',
  'retainedGeometry.chip.label': 'Retained · shape-only · {published}/{candidates} products · {refused} refused',
  'retainedGeometry.chip.labelCancelled': 'Retained · shape-only · {published}/{candidates} products · {refused} refused · {cancelled} cancelled',
  'retainedGeometry.chip.state.running': 'running',
  'retainedGeometry.chip.state.complete': 'complete',
  'retainedGeometry.chip.state.incomplete': 'incomplete',
  'retainedGeometry.chip.state.stopped': 'stopped',
  'retainedGeometry.chip.title': 'Retained geometry is shape-only. Not applied: {obligations}. Open the Retained geometry panel.',
  'retainedGeometry.chip.titleNone': 'Retained geometry is shape-only. Open the Retained geometry panel.',
  'retainedGeometry.chip.aria': 'Open the Retained geometry panel',

  'retainedGeometry.obligation.ProductPlacement': 'product placement',
  'retainedGeometry.obligation.OpeningClosure': 'openings',
  'retainedGeometry.obligation.MaterialLayers': 'material layers',
  'retainedGeometry.obligation.IfcAppearance': 'appearance',
  'retainedGeometry.obligation.PersistentFaces': 'persistent faces',
  'retainedGeometry.obligation.SurfaceNormals': 'surface normals',

  'retainedGeometry.faces.hint': 'Select a published product to list its persistent faces.',
  'retainedGeometry.faces.title': 'Persistent faces of #{id} ({count})',
  'retainedGeometry.faces.column.key': 'Source face',
  'retainedGeometry.faces.column.triangles': 'Triangles',
  'retainedGeometry.faces.column.area': 'Area (m²)',

  'retainedGeometry.panel.title': 'Retained geometry',
  'retainedGeometry.panel.description': 'Shape-only geometry from the retained kernel. Products listed below have no geometry in the viewport, and no exact geometry stands in for them.',
  'retainedGeometry.panel.counts': '{published} of {candidates} products published · {refused} refused · {cancelled} cancelled',
  'retainedGeometry.panel.state.running': 'Running: products are still arriving.',
  'retainedGeometry.panel.state.complete': 'Complete: every product has retained geometry.',
  'retainedGeometry.panel.state.incomplete': 'Incomplete: {count} of {candidates} products have no geometry.',
  'retainedGeometry.panel.state.failure': 'Stopped: {reason}',
  'retainedGeometry.panel.notApplied': 'Not applied to published products: {obligations}.',
  'retainedGeometry.panel.filterLabel': 'Filter by code',
  'retainedGeometry.panel.filterAll': 'All codes ({count})',
  'retainedGeometry.panel.filterCode': '{code} ({count})',
  'retainedGeometry.panel.column.id': 'ID',
  'retainedGeometry.panel.column.ifcType': 'IFC type',
  'retainedGeometry.panel.column.code': 'Code',
  'retainedGeometry.panel.column.origin': 'Origin',
  'retainedGeometry.panel.column.message': 'Message',
  'retainedGeometry.panel.sortBy': 'Sort by {column}',
  'retainedGeometry.panel.rowId': '#{id}',
  'retainedGeometry.panel.selectRow': 'Select #{id}',
  'retainedGeometry.panel.unknownType': 'Not reached',
  'retainedGeometry.panel.origin': '{cause} at {site}',
  'retainedGeometry.panel.originEntity': '{cause} at {site} (#{entity})',
  'retainedGeometry.panel.none': 'Every product was published.',
  'retainedGeometry.panel.noMatches': 'No products with this code.',
  'retainedGeometry.panel.reloadExact': 'Reload with exact kernel',
  'retainedGeometry.panel.reloadUnavailable': 'The source file is no longer open. Open it again to load it with the exact kernel.',
  'retainedGeometry.panel.engine': 'Engine and licences',
  'retainedGeometry.panel.engineLoading': 'Reading the engine manifest…',
  'retainedGeometry.panel.engineUnavailable': 'Engine manifest unavailable: {reason}',
  'retainedGeometry.panel.sdkRevision': 'SDK revision {revision}',
  'retainedGeometry.panel.manifestDigest': 'Manifest sha256 {digest}',
  'retainedGeometry.panel.licence.smlib': 'SMLib licence',
  'retainedGeometry.panel.licence.smlibNotices': 'SMLib third-party notices',
  'retainedGeometry.panel.licence.ifcLite': 'ifc-lite licence',
  'retainedGeometry.panel.close': 'Close',

  'retainedGeometry.code.opening_strategy': 'Openings are not supported by the retained kernel yet.',
  'retainedGeometry.code.material_layer_strategy': 'Material layers are not supported by the retained kernel yet.',
  'retainedGeometry.code.operation_unsupported': 'Uses a geometry operation the retained kernel does not support yet.',
  'retainedGeometry.code.source_invalid': 'The source geometry is invalid.',
  'retainedGeometry.code.source_changed': 'The source changed while the product was computed.',
  'retainedGeometry.code.incomplete': 'The product geometry could not be fully resolved.',
  'retainedGeometry.code.empty_result': 'The product geometry resolved to nothing.',
  'retainedGeometry.code.family_unqualified': 'This geometry family is not qualified for the retained kernel.',
  'retainedGeometry.code.kernel_failure': 'The geometry kernel failed on this product.',
  'retainedGeometry.code.worker_fault': 'The kernel worker failed on this product.',
  'retainedGeometry.code.worker_retired': 'The kernel worker was retired before this product.',
  'retainedGeometry.code.resource_exhausted': 'The product exceeded its memory or work budget.',
  'retainedGeometry.code.deadline_exceeded': 'The product exceeded its time budget.',
  'retainedGeometry.code.cancelled': 'Not computed: the run stopped before this product.',
  'retainedGeometry.code.contract_breach': 'The kernel returned output that broke its contract.',
  'retainedGeometry.code.opening_unsupported': 'Uses an opening the retained kernel cannot cut yet.',
  'retainedGeometry.code.appearance_unsupported': 'Uses textures or indexed colour palettes, which the retained kernel does not reproduce.',
  'retainedGeometry.code.face_provenance_unproven': 'Its faces could not be traced back to the source geometry.',
  'retainedGeometry.code.other': 'Refused with code {code}.',

  'retainedGeometry.setting.title': 'Geometry kernel',
  'retainedGeometry.setting.hint': 'Applies to the next load in this tab. A new tab starts with Exact again.',
  'retainedGeometry.setting.exact': 'Exact (default)',
  'retainedGeometry.setting.retained': 'Retained (experimental, shape-only)',

  'retainedGeometry.progress.starting': 'Starting retained engine',
  'retainedGeometry.progress.products': 'Retained geometry: {done}/{candidates} products ({refused} refused)',

  'retainedGeometry.scope.federated': 'Retained geometry loads one model at a time, so "{file}" was not added. Retry adds it with the exact kernel.',
  'retainedGeometry.scope.federatedOnRetained': 'A retained model is open, and retained geometry shows one model at a time. Reload it with the exact kernel to add "{file}".',
  'retainedGeometry.scope.format': 'Retained geometry covers IFC (STEP) files only, so "{file}" was not loaded. Retry loads it with the exact kernel.',
  'retainedGeometry.scope.size': '"{file}" is {size}; retained geometry is limited to {limit} for now. Retry loads it with the exact kernel.',
} as const satisfies Record<string, TranslationValue>;

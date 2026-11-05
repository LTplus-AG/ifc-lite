/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { retainedGeometryEn } from './catalogues/retained-geometry.en';

/** Startup validation metadata; checked against the real lazy catalogue in tests. */
export const retainedCatalogueShape = {
  "retainedGeometry.shapeOnlyReason": [],
  "retainedGeometry.exactOnlyExportReason": [],
  "retainedGeometry.final": [],
  "retainedGeometry.shapeOnly": [],
  "retainedGeometry.chip.titleFinal": [],
  "retainedGeometry.panel.final": [],
  "retainedGeometry.chip.starting": [
    "presentation"
  ],
  "retainedGeometry.chip.running": [
    "candidates",
    "done",
    "presentation"
  ],
  "retainedGeometry.chip.label": [
    "candidates",
    "presentation",
    "published",
    "refused"
  ],
  "retainedGeometry.chip.labelCancelled": [
    "cancelled",
    "candidates",
    "presentation",
    "published",
    "refused"
  ],
  "retainedGeometry.chip.state.running": [],
  "retainedGeometry.chip.state.complete": [],
  "retainedGeometry.chip.state.incomplete": [],
  "retainedGeometry.chip.state.stopped": [],
  "retainedGeometry.chip.title": [
    "obligations"
  ],
  "retainedGeometry.chip.titleNone": [],
  "retainedGeometry.chip.aria": [],
  "retainedGeometry.obligation.ProductPlacement": [],
  "retainedGeometry.obligation.OpeningClosure": [],
  "retainedGeometry.obligation.MaterialLayers": [],
  "retainedGeometry.obligation.IfcAppearance": [],
  "retainedGeometry.obligation.PersistentFaces": [],
  "retainedGeometry.obligation.SurfaceNormals": [],
  "retainedGeometry.faces.hint": [],
  "retainedGeometry.faces.title": [
    "count",
    "id"
  ],
  "retainedGeometry.faces.column.key": [],
  "retainedGeometry.faces.column.triangles": [],
  "retainedGeometry.faces.column.area": [],
  "retainedGeometry.panel.title": [],
  "retainedGeometry.panel.description": [],
  "retainedGeometry.panel.counts": [
    "cancelled",
    "candidates",
    "published",
    "refused"
  ],
  "retainedGeometry.panel.state.running": [],
  "retainedGeometry.panel.state.complete": [],
  "retainedGeometry.panel.state.incomplete": [
    "candidates",
    "count"
  ],
  "retainedGeometry.panel.state.failure": [
    "reason"
  ],
  "retainedGeometry.panel.notApplied": [
    "obligations"
  ],
  "retainedGeometry.panel.filterLabel": [],
  "retainedGeometry.panel.filterAll": [
    "count"
  ],
  "retainedGeometry.panel.filterCode": [
    "code",
    "count"
  ],
  "retainedGeometry.panel.column.id": [],
  "retainedGeometry.panel.column.ifcType": [],
  "retainedGeometry.panel.column.code": [],
  "retainedGeometry.panel.column.origin": [],
  "retainedGeometry.panel.column.message": [],
  "retainedGeometry.panel.sortBy": [
    "column"
  ],
  "retainedGeometry.panel.rowId": [
    "id"
  ],
  "retainedGeometry.panel.selectRow": [
    "id"
  ],
  "retainedGeometry.panel.unknownType": [],
  "retainedGeometry.panel.origin": [
    "cause",
    "site"
  ],
  "retainedGeometry.panel.originEntity": [
    "cause",
    "entity",
    "site"
  ],
  "retainedGeometry.panel.none": [],
  "retainedGeometry.panel.noMatches": [],
  "retainedGeometry.panel.rowsCapped": [
    "count",
    "shown"
  ],
  "retainedGeometry.panel.rowsMore": [
    "count"
  ],
  "retainedGeometry.panel.reloadExact": [],
  "retainedGeometry.panel.reloadUnavailable": [],
  "retainedGeometry.panel.engine": [],
  "retainedGeometry.panel.engineLoading": [],
  "retainedGeometry.panel.engineUnavailable": [
    "reason"
  ],
  "retainedGeometry.panel.sdkRevision": [
    "revision"
  ],
  "retainedGeometry.panel.manifestDigest": [
    "digest"
  ],
  "retainedGeometry.panel.licence.smlib": [],
  "retainedGeometry.panel.licence.smlibNotices": [],
  "retainedGeometry.panel.licence.ifcLite": [],
  "retainedGeometry.panel.close": [],
  "retainedGeometry.code.opening_strategy": [],
  "retainedGeometry.code.material_layer_strategy": [],
  "retainedGeometry.code.operation_unsupported": [],
  "retainedGeometry.code.source_invalid": [],
  "retainedGeometry.code.source_changed": [],
  "retainedGeometry.code.incomplete": [],
  "retainedGeometry.code.empty_result": [],
  "retainedGeometry.code.family_unqualified": [],
  "retainedGeometry.code.kernel_failure": [],
  "retainedGeometry.code.worker_fault": [],
  "retainedGeometry.code.worker_retired": [],
  "retainedGeometry.code.resource_exhausted": [],
  "retainedGeometry.code.deadline_exceeded": [],
  "retainedGeometry.code.cancelled": [],
  "retainedGeometry.code.contract_breach": [],
  "retainedGeometry.code.opening_unsupported": [],
  "retainedGeometry.code.appearance_unsupported": [],
  "retainedGeometry.code.face_provenance_unproven": [],
  "retainedGeometry.code.other": [
    "code"
  ],
  "retainedGeometry.setting.title": [],
  "retainedGeometry.setting.hint": [],
  "retainedGeometry.setting.unavailable": [],
  "retainedGeometry.setting.exact": [],
  "retainedGeometry.setting.retained": [],
  "retainedGeometry.progress.starting": [],
  "retainedGeometry.progress.products": [
    "candidates",
    "done",
    "refused"
  ],
  "retainedGeometry.scope.federated": [
    "file"
  ],
  "retainedGeometry.scope.federatedOnRetained": [
    "file"
  ],
  "retainedGeometry.scope.format": [
    "file"
  ],
  "retainedGeometry.scope.size": [
    "file",
    "limit",
    "size"
  ],
  "retainedGeometry.hostFailure": [
    "file",
    "reason"
  ],
  "retainedGeometry.engineMissing": [
    "file",
    "reason"
  ],
  "retainedGeometry.memory": [
    "file"
  ]
} satisfies Record<keyof typeof retainedGeometryEn, readonly string[]>;

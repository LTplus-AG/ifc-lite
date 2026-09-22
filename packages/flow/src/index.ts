/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  item,
  list,
  group,
  flatten,
  asGroup,
  countItems,
  isAssignable,
  SINGLE_BRANCH,
} from './values.js';
export type {
  Access,
  Lacing,
  GroupKey,
  FlowData,
  Scalar,
  EntityRef,
  Point,
  Polyline,
  Placement,
  Profile,
  ValueKind,
  PortType,
} from './values.js';

export { COLUMN_TYPES, validateTable, column, rowKey, groupRows, pivot } from './table.js';
export type { ColumnType, Column, Cell, Row, Table, TableProblem, GroupedRows } from './table.js';

export { canonicalJson, digest, digestFlowData, trackingGuid } from './digest.js';

export { NodeRegistry, resolveParams } from './registry.js';
export type { PortDef, ParamDef, ParamKind, LogLevel, LaneTracking, NodeRunContext, NodeOutputs, NodeDef } from './registry.js';

export { planLift, assemble, CrossProductTooLarge } from './lift.js';
export type { LiftInput, Lane, LiftPlan, LiftOptions } from './lift.js';

export { FLOW_VERSION, validateFlowDocument, parseFlowDocument, migrateFlowDocument } from './document.js';
export type {
  TrackingMode,
  InputKind,
  FlowNode,
  FlowEdge,
  FlowInput,
  FlowOutput,
  FlowDocument,
  DocumentProblem,
} from './document.js';

export {
  TRACKING_SIDECAR_VERSION,
  emptyTrackedSet,
  planTracking,
  trackedSetFrom,
  withTrackedSet,
  TrackingPinMismatch,
  MemoryTrackingStore,
} from './tracking.js';
export type { TrackedEntry, TrackedSet, TrackingSidecar, TrackingStore, DesiredLane, TrackingPlan } from './tracking.js';

export { validateFlowWiring } from './wiring.js';
export { nodeAvailability, checkAvailability } from './availability.js';
export type { HostFeatures, AvailabilityStatus, NodeAvailability } from './availability.js';

export { runFlow, topologicalOrder, MemoCache, FlowCycleError, DEFAULT_MAX_CROSS } from './scheduler.js';
export { trackingKeyOf, ORPHAN_NODE_ID } from './orphans.js';
export type { RunOptions, RunResult, RunLogEntry, NodeReport, NodeStatus, GraphOutputValue } from './scheduler.js';

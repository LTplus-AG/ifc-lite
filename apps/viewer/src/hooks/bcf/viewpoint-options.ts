/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ComponentRef } from '../bcfIdLookup';
import type { CapturedSectionPlane } from './section-plane-position';
export interface CreateViewpointOptions {
  /** Include a snapshot image */
  includeSnapshot?: boolean;
  /** Already-rendered PNG; camera/clipping still use the canonical conversion. */ snapshotOverride?: string;
  /** Exact cut rendered by a 2D section snapshot, independent of 3D clipping. */ capturedSectionPlane?: CapturedSectionPlane;
  /** Include selected entities */
  includeSelection?: boolean;
  /** Include hidden entities */
  includeHidden?: boolean;
  /**
   * Federated entity refs to record in the viewpoint's `<Selection>` as
   * "found objects", INDEPENDENT of the live viewer selection (merged in
   * alongside whatever `includeSelection` derives, deduped). When omitted and
   * `includeSelection` is on, the focused clash's painted elements are used
   * (`focusedClashComponents`): `focusClash` clears the live selection and
   * paints the pair only through the clash colour channel (#1277/#1339), so
   * without this every capture made while a clash is focused had no
   * `<Selection>` at all (#4806).
   */
  additionalSelectedRefs?: ComponentRef[];
  /** IFC GlobalIds already bound to a validated model revision by the caller. */
  additionalSelectedGuids?: string[];
  /**
   * Federated entity refs to record as BCF `<Coloring>`, grouped by an ARGB
   * hex colour (e.g. `'FFFF8000'`, matching `BCFColoring.color`). Defaults
   * like `additionalSelectedRefs`, to the focused clash's on-screen tint.
   */
  additionalColoredRefs?: { color: string; refs: ComponentRef[] }[];
  /** Coloring already bound to a validated model revision by the caller. */
  additionalColoredGuids?: { color: string; guids: string[] }[];
  /** Model-bound GUIDs that supplement an active numeric isolation allowlist. */
  additionalVisibleGuids?: string[];
  /** Abort when caller-owned scene identity changes while snapshot capture yields. */
  isCaptureStillValid?: () => boolean;
  /** Exact source models represented by the visibility state bound for this capture. */
  onVisibilityModelIdsCaptured?: (modelIds: readonly string[]) => void;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reviewed native authoring (viewer AI P15A): a serialisable, bounded batch of
 * creation, deletion, placement and relationship edits that the viewer's own
 * builders and modelling commands carry out. A sibling of `model.changes`
 * (P04), not a new version of it: data corrections compare one scalar with
 * an expected scalar, while authoring creates identities, takes lengths in a
 * declared unit and frame, and may refer to an element created earlier in the
 * same batch. Both share the GlobalId resolution, the staleness rule, one
 * native undo batch per model and the receipt library.
 *
 * Every length in a batch is in its declared `units` (`m` or `mm`), in the
 * storey-local frame (IFC Z-up, metres from the storey's placement after
 * conversion), the frame the in-store builders take. Angles are degrees,
 * counter-clockwise seen from above. Nothing here writes.
 */

import { parseShapeParams, parseProfileSectionParams, AUTHORING_OUTLINE_WORK_LIMIT, type ShapeParams } from './model-authoring-shape-params';
import { parseSizeParams, type ExpectedSize } from './model-authoring-size-params';
import type { ProfileSection } from '@ifc-lite/create';
import type { ElementSizePatch } from '@/store/slices/mutation-element-size';
import { parseCopyFields, type CopyFields, type ArrayFields } from './model-authoring-copy-fields';

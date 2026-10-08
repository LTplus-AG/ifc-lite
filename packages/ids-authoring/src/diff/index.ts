/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { diffDocuments } from './diff.js';
export { diffToOps, type PatchOptions } from './patch.js';
export { changelog, changelogMarkdown, describeChange, facetLabel, type ChangelogLine, type ChangelogOptions } from './changelog.js';
export type {
  DiffEntry,
  DiffEntryKind,
  DiffOptions,
  DiffOrder,
  DocumentDiff,
  FacetAlignment,
  FacetContext,
  RequirementField,
  SpecAlignment,
  SpecField,
} from './types.js';

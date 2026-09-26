/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Translation-key lookup tables for `LensPanel.tsx`'s two shared display
 * concepts (#4918): a rule's comparison {@link LensOperator} and a rule
 * criteria's / auto-color source's TYPE. Split out of `LensPanel.tsx` itself
 * (which is near its module-size budget) purely to keep new code out of an
 * already-large allowlisted file — same `labelKey`-table pattern
 * `sectionConstants.ts`'s `AXIS_INFO` and the clash-panel catalogue's
 * `SEVERITY`/`REVIEW_STATUS` tables use, just relocated rather than
 * redesigned.
 */
import type { LensOperator } from '@ifc-lite/lens';
import type { TranslationKey } from '@/i18n';
import { LENS_OPERATOR_LABEL_KEYS } from '@/lib/filter-operator-labels';

/**
 * Translation key for every {@link LensOperator}, for the operator
 * `<select>`s in `LensPanel.tsx`. Every value `LENS_OPERATORS` (from
 * `@ifc-lite/lens`) exports must appear here — an operator missing from an
 * option list falls back to the browser's first-option default on render
 * (`selectedIndex` -1/0 depending on the engine), silently misdisplaying a
 * rule whose value the engine still honours correctly. See the `and`/`or`
 * compound criteria-type selector in `LensPanel.tsx`'s `RuleEditor` for the
 * identical defect class this table's introduction (pre-#4918) already
 * fixed once.
 */
export const OPERATOR_LABEL_KEYS: Record<LensOperator, TranslationKey> = LENS_OPERATOR_LABEL_KEYS;

/** Human-readable label key for source / criteria types (shared) */
export const TYPE_LABEL_KEYS: Record<string, TranslationKey> = {
  ifcType: 'lensPanel.type.ifcType',
  attribute: 'lensPanel.type.attribute',
  property: 'lensPanel.type.property',
  quantity: 'lensPanel.type.quantity',
  classification: 'lensPanel.type.classification',
  material: 'lensPanel.type.material',
  model: 'lensPanel.type.model',
  group: 'lensPanel.type.group',
};

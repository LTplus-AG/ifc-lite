/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isAutomationReportProvenance, type AutomationReportProvenance } from './portable-automation-provenance.js';
import { isFullSourceSHA256 } from './portable-source-contract.js';
export interface PortableReportValidationError { path: string; message: string }

/** Opaque sRGB document colours; named/alpha/short forms are intentionally excluded. */
export function isRgbColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/** Heading text size in points: absent prints the default; the bounds match the chart text size (6-24). */
export const BLOCK_TITLE_SIZE_MIN = 6;
export const BLOCK_TITLE_SIZE_MAX = 24;

/** How the heading looks, shared by every block kind that has one (#6632). Absent fields print as before. */
export interface BlockHeaderStyleFields {
  /** Heading text size, `BLOCK_TITLE_SIZE_MIN`-`BLOCK_TITLE_SIZE_MAX` points. */
  titleFontSize?: number;
  /** Heading ink in `#RRGGBB`; absent is black, or black/white by contrast when a background is set. */
  titleTextColor?: string;
  /** Heading strip background in `#RRGGBB`; absent is transparent paper. */
  titleBackgroundColor?: string;
}

/** Authored presentation belongs to the document, independently of its source (#6547). */
export interface BlockTitle extends BlockHeaderStyleFields {
  title?: string;
}

export function validateBlockTitle(block: Record<string, unknown>, at: string, errors: PortableReportValidationError[]): void {
  if (block.title !== undefined && typeof block.title !== 'string') errors.push({ path: `${at}.title`, message: 'expected a string' });
  const size = block.titleFontSize;
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size < BLOCK_TITLE_SIZE_MIN || size > BLOCK_TITLE_SIZE_MAX)) {
    errors.push({ path: `${at}.titleFontSize`, message: `expected a number between ${BLOCK_TITLE_SIZE_MIN} and ${BLOCK_TITLE_SIZE_MAX}` });
  }
  for (const key of ['titleTextColor', 'titleBackgroundColor'] as const) {
    if (block[key] !== undefined && !isRgbColor(block[key])) errors.push({ path: `${at}.${key}`, message: 'expected an RGB colour in #RRGGBB form' });
  }
}

/** Source identity is evidence about the original run, never a live selector. */
export interface ReportModelScope { name: string; fingerprint?: string; sourceContentHash?: string }
/** The author's choice to print or omit a report's stamp rows (#6566, #6678).
 * Absent means shown, so every document saved before the choice printed the same. */
export interface ReportStampChoice {
  showStamp?: boolean;
}
export interface ReportProvenance extends ReportStampChoice {
  savedReportId?: string;
  /** Captured workflow execution identity; travels with the evidence, never a live binding. */
  automation?: AutomationReportProvenance;
  reportModels?: ReportModelScope[];
}

export function validateReportProvenance(block: Record<string, unknown>, at: string, errors: PortableReportValidationError[]): void {
  if (block.showStamp !== undefined && typeof block.showStamp !== 'boolean') errors.push({ path: `${at}.showStamp`, message: 'expected a boolean' });
  if (block.automation !== undefined && !isAutomationReportProvenance(block.automation)) {
    errors.push({ path: `${at}.automation`, message: 'expected valid workflow report provenance' });
  }
  if (block.savedReportId !== undefined && (typeof block.savedReportId !== 'string' || !block.savedReportId)) {
    errors.push({ path: `${at}.savedReportId`, message: 'expected a non-empty string' });
  }
  if (block.reportModels !== undefined && (!Array.isArray(block.reportModels) || !block.reportModels.every((model: unknown) => {
    if (typeof model !== 'object' || model === null || Array.isArray(model)) return false;
    const m = model as Record<string, unknown>;
    return typeof m.name === 'string' && m.name.trim().length > 0
      && (m.fingerprint === undefined || (typeof m.fingerprint === 'string' && m.fingerprint.length > 0))
      && (m.sourceContentHash === undefined || isFullSourceSHA256(m.sourceContentHash));
  }))) errors.push({ path: `${at}.reportModels`, message: 'expected non-empty model names, optional non-empty fingerprints and optional lowercase 64-hex sourceContentHash' });
}

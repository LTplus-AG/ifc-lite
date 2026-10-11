/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW feature catalogue and detection (IDS-124).
 *
 * `findIds11Features` is the one answer to "does this document need the
 * 1.1 preview?". The writer refuses to write such a document as IDS 1.0,
 * and the validator refuses to judge it, unless the caller passed
 * `preview: { ids11: true }` (ADR-011: 1.1 candidates cannot leak into 1.0
 * output, and a 1.0 run must not silently ignore a 1.1 condition).
 */

import type { IDSConstraint } from '../constraint-types.js';
import type { IDSDocument, IDSFacet } from '../types.js';
import type { IDS11FeatureUse, IDS11PreviewFeature, IDSPreviewFlags } from './types.js';

/** One modelled IDS 1.1 PREVIEW candidate and where upstream discusses it. */
export interface IDS11FeatureInfo {
  /** Short label for messages and docs. */
  label: string;
  /** buildingSMART/IDS issues and pull requests the semantics come from. */
  upstream: readonly string[];
  /** Upstream state when this was modelled (2026-10-08). */
  upstreamStatus: 'merged-on-1.1-branch' | 'open-proposal' | 'draft-pr';
  /** Whether the feature has an XML form (tolerance is a comparison rule only). */
  xml: boolean;
}

/** The modelled IDS 1.1 PREVIEW candidates. Unstable: follows upstream. */
export const IDS11_PREVIEW_FEATURES: Readonly<Record<IDS11PreviewFeature, IDS11FeatureInfo>> = {
  'facet-uri-in-applicability': {
    label: 'uri on property, classification and material facets in applicability',
    upstream: ['buildingSMART/IDS#188', 'buildingSMART/IDS#251', 'buildingSMART/IDS#382'],
    upstreamStatus: 'merged-on-1.1-branch',
    xml: true,
  },
  'facet-instructions-in-applicability': {
    label: 'instructions on applicability facets',
    upstream: ['buildingSMART/IDS#154'],
    upstreamStatus: 'open-proposal',
    xml: true,
  },
  'partof-nested-facets': {
    label: 'attribute, property, classification and material facets nested in partOf',
    upstream: ['buildingSMART/IDS#379', 'buildingSMART/IDS#380'],
    upstreamStatus: 'draft-pr',
    xml: true,
  },
  'tolerance-418': {
    label: 'inclusive numeric tolerance with bounds rounded to 15 decimals',
    upstream: ['buildingSMART/IDS#418'],
    upstreamStatus: 'open-proposal',
    xml: false,
  },
};

function hasToleranceRule(constraint: IDSConstraint | undefined): boolean {
  if (!constraint) return false;
  if (constraint.type === 'simpleValue') return constraint.toleranceRule !== undefined;
  if (constraint.type === 'enumeration' && constraint.toleranceRule !== undefined) return true;
  return (constraint.and ?? []).some(hasToleranceRule);
}

function valueOf(facet: IDSFacet): IDSConstraint | undefined {
  return facet.type === 'entity' || facet.type === 'partOf' ? undefined : facet.value;
}

type FacetContext = 'applicability' | 'requirement' | 'nested';

function visitFacet(facet: IDSFacet, path: string, context: FacetContext, out: IDS11FeatureUse[]): void {
  // A requirement facet's uri is IDS 1.0; elsewhere it is the 1.1 candidate.
  if (context !== 'requirement' && 'uri' in facet && facet.uri !== undefined) {
    out.push({ feature: 'facet-uri-in-applicability', path });
  }
  // #154 proposes instructions on applicability facets. A requirement keeps
  // its instructions on IDSRequirement (IDS 1.0); the writer refuses the
  // facet-level field anywhere but applicability.
  if (context === 'applicability' && facet.instructions !== undefined) {
    out.push({ feature: 'facet-instructions-in-applicability', path });
  }
  if (hasToleranceRule(valueOf(facet))) out.push({ feature: 'tolerance-418', path });
  if (facet.type === 'partOf' && facet.facets !== undefined) {
    out.push({ feature: 'partof-nested-facets', path });
    facet.facets.forEach((nested, i) => visitFacet(nested, `${path}.facets[${i}]`, 'nested', out));
  }
}

/** Every use of an IDS 1.1 PREVIEW feature in `doc`, in document order. */
export function findIds11Features(doc: IDSDocument): IDS11FeatureUse[] {
  const out: IDS11FeatureUse[] = [];
  doc.specifications.forEach((spec, s) => {
    spec.applicability.facets.forEach((facet, i) =>
      visitFacet(facet, `specifications[${s}].applicability.facets[${i}]`, 'applicability', out));
    spec.requirements.forEach((req, i) =>
      visitFacet(req.facet, `specifications[${s}].requirements[${i}]`, 'requirement', out));
  });
  return out;
}

/** Error thrown when a document needs IDS 1.1 PREVIEW and the caller did not opt in. */
export class IDS11PreviewRequiredError extends Error {
  constructor(
    public readonly caller: string,
    public readonly uses: readonly IDS11FeatureUse[],
  ) {
    const first = uses[0];
    const where = first ? `${IDS11_PREVIEW_FEATURES[first.feature].label} at ${first.path}` : '';
    super(
      `${caller}: the document uses IDS 1.1 preview features (${where}` +
        `${uses.length > 1 ? ` and ${uses.length - 1} more` : ''}); ` +
        'pass preview: { ids11: true } to opt in. IDS 1.1 is not released.',
    );
    this.name = 'IDS11PreviewRequiredError';
  }
}

/**
 * Throw `IDS11PreviewRequiredError` when `doc` uses a 1.1 PREVIEW feature
 * and `flags.ids11` is not set. `xmlOnly` limits the check to features with
 * an XML form (the writer has nothing to write for a tolerance rule).
 */
export function assertIds11Allowed(
  doc: IDSDocument,
  flags: IDSPreviewFlags | undefined,
  caller: string,
  xmlOnly = false,
): IDS11FeatureUse[] {
  const uses = findIds11Features(doc).filter((u) => !xmlOnly || IDS11_PREVIEW_FEATURES[u.feature].xml);
  if (uses.length > 0 && flags?.ids11 !== true) throw new IDS11PreviewRequiredError(caller, uses);
  return uses;
}

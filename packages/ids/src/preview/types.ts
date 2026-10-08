/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW types (IDS-124, ADR-011).
 *
 * IDS 1.1 is not released. Everything in this module models CANDIDATE
 * features from the buildingSMART/IDS 1.1 milestone, each tied to the
 * upstream issue or pull request it comes from. Nothing here is read,
 * written or evaluated unless the caller opts in with
 * `preview: { ids11: true }`; without it, parser, writer, validator and
 * audit behave exactly as for IDS 1.0. Semantics may change or disappear
 * when upstream decides, so treat this surface as unstable.
 */

/**
 * Opt-in flags for unreleased IDS versions. PREVIEW: unstable surface.
 * Accepted by `parseIDS`, `writeIdsXml`, `validateIDS` and the audit.
 */
export interface IDSPreviewFlags {
  /**
   * IDS 1.1 PREVIEW candidate features: `uri` on applicability facets
   * (#188, #251), `instructions` on applicability facets (#154), nested
   * facets in `partOf` (#379, draft PR #380), identifier uniqueness
   * (#339) and the #418 tolerance bounds. Default `false`.
   */
  ids11?: boolean;
}

/**
 * The IDS 1.1 PREVIEW candidate features this package models, by stable id.
 * See `IDS11_PREVIEW_FEATURES` for the upstream source of each.
 */
export type IDS11PreviewFeature =
  | 'facet-uri-in-applicability'
  | 'facet-instructions-in-applicability'
  | 'partof-nested-facets'
  | 'tolerance-418';

/** Where a document uses an IDS 1.1 PREVIEW feature. */
export interface IDS11FeatureUse {
  feature: IDS11PreviewFeature;
  /** Path into the document, e.g. `specifications[0].applicability.facets[1]`. */
  path: string;
}

/**
 * IDS 1.1 PREVIEW: `uri` on a property, classification or material facet.
 * IDS 1.0 allows it in requirements only; the 1.1 branch also allows it in
 * applicability (#188, #251, merged upstream as PR #382). It identifies
 * the concept (for example a bSDD URI) and is never checked against a model.
 */
export interface IDS11FacetUri {
  /** IDS 1.1 PREVIEW. Only set by `parseIDS(xml, { preview: { ids11: true } })`. */
  uri?: string;
}

/**
 * IDS 1.1 PREVIEW: `instructions` on an APPLICABILITY facet, as proposed for
 * 1.1 in #154 ("add instructions to all facets"). Requirement instructions
 * stay on `IDSRequirement.instructions` (IDS 1.0); the writer refuses this
 * field on a requirement facet so there is one home per context.
 */
export interface IDS11FacetInstructions {
  /** IDS 1.1 PREVIEW. Only set by `parseIDS(xml, { preview: { ids11: true } })`. */
  instructions?: string;
}

/**
 * IDS 1.1 PREVIEW: the tolerance rule a simple value or enumeration is
 * compared with. `'ids11-418'` is the #418 candidate: bounds
 * `v ∓ (|v|·1e-6 + 1e-6)`, each rounded to 15 decimal places (half to even),
 * compared inclusively. Set on value constraints by the preview parser.
 */
export type IDS11ToleranceRule = 'ids11-418';

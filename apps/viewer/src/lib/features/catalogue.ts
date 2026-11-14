/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The feature catalogue: every part of the viewer a host can switch off.
 *
 * A host that embeds or deploys the viewer for its users hands it a
 * `ViewerRuntimeConfig` naming feature ids from this list. The build emits
 * the same list as `features.json` next to `index.html`, so an administration
 * page can render one switch per feature without hardcoding an id.
 *
 * Ids are a compatibility contract: once shipped, an id is never renamed or
 * reused. A config naming an id this viewer does not know is ignored, so old
 * viewers and new configs mix.
 *
 * What is NOT listed here is the baseline and cannot be switched off: the 3D
 * view and its navigation, selection, the model tree, the properties panel,
 * search, visibility and isolation, the command palette and settings.
 *
 * Labels and descriptions are English, written for the administrator who
 * flips the switches. They are data for the host's page, never rendered by
 * the viewer, which is why they are not in the i18n catalogues.
 *
 * Pure data with no imports: `vite.config.ts` loads this module to emit
 * `features.json`.
 */

export interface FeatureGroupDefinition {
  readonly id: string;
  readonly label: string;
}

export interface FeatureDefinition {
  /** Stable, dotted, lower-case: `<group>.<name>`. */
  readonly id: string;
  readonly group: string;
  readonly label: string;
  /** What the user loses when this is off. */
  readonly description: string;
}

export const FEATURE_GROUPS = [
  { id: 'privacy', label: 'Telemetry and privacy' },
] as const satisfies readonly FeatureGroupDefinition[];

export const FEATURE_CATALOGUE = [
  { id: 'privacy.analytics', group: 'privacy', label: 'Product analytics',
    description: 'Anonymous usage analytics sent to the analytics service configured in the build, and the setting that lets a user opt out.' },
  { id: 'privacy.vercel-analytics', group: 'privacy', label: 'Hosting analytics script',
    description: 'The page-view analytics script of the hosting platform.' },
  { id: 'privacy.notice', group: 'privacy', label: 'Privacy notice',
    description: 'The first-visit notice about the local action log and hosted analytics.' },
] as const satisfies readonly FeatureDefinition[];

export type FeatureId = (typeof FEATURE_CATALOGUE)[number]['id'];

/** The `features.json` document a build emits next to `index.html`. */
export interface FeatureCatalogueDocument {
  readonly version: 1;
  readonly groups: readonly FeatureGroupDefinition[];
  readonly features: readonly FeatureDefinition[];
}

export function featureCatalogueDocument(): FeatureCatalogueDocument {
  return { version: 1, groups: FEATURE_GROUPS, features: FEATURE_CATALOGUE };
}

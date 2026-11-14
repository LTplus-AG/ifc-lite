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
  { id: 'files', label: 'Files and models' },
  { id: 'tools', label: 'Viewport tools' },
  { id: 'view', label: 'Display and presentation' },
  { id: 'check', label: 'Checking and coordination' },
  { id: 'data', label: 'Data and quantities' },
  { id: 'edit', label: 'Editing' },
  { id: 'automate', label: 'Automation' },
  { id: 'ai', label: 'AI' },
  { id: 'collab', label: 'Collaboration' },
  { id: 'export', label: 'Export' },
  { id: 'privacy', label: 'Telemetry and privacy' },
  { id: 'help', label: 'Help' },
] as const satisfies readonly FeatureGroupDefinition[];

export const FEATURE_CATALOGUE = [
  { id: 'files.local', group: 'files', label: 'Open local files',
    description: 'Opening and adding models from the device: the Open and Add model commands, drag and drop onto the viewer, refresh from disk and the recent files list.' },
  { id: 'files.federation-setup', group: 'files', label: 'Federation setup files',
    description: 'Saving the current set of models and their alignment as a setup file, and opening one.' },
  { id: 'files.sources', group: 'files', label: 'Cloud sources',
    description: 'The Cloud sources panel, which connects to common data environments and file services to open models from them.' },
  { id: 'files.samples', group: 'files', label: 'Sample models',
    description: 'The sample project and the layers demo on the start screen and in empty panels. Guided tours that load the sample project go too.' },

  { id: 'tools.measure', group: 'tools', label: 'Measure',
    description: 'The Measure tool and the Measurements panel.' },
  { id: 'tools.section', group: 'tools', label: 'Section',
    description: 'The Section tool: cutting planes through the model.' },
  { id: 'tools.walk', group: 'tools', label: 'Walk',
    description: 'The first-person Walk tool.' },
  { id: 'tools.annotate', group: 'tools', label: 'Annotate',
    description: 'The Annotate tool: markup drawn over the 3D view.' },

  { id: 'view.lens', group: 'view', label: 'Lenses',
    description: 'The Lens panel: colouring and filtering elements by rules.' },
  { id: 'view.environment', group: 'view', label: 'Environment',
    description: 'The Environment panel: sky, lighting presets and the sun study.' },
  { id: 'view.appearance', group: 'view', label: 'Appearance',
    description: 'The Appearance panel: images and textures on model surfaces.' },
  { id: 'view.drawings', group: 'view', label: '2D drawings',
    description: 'The Drawing panel: 2D plans and sections generated from the model.' },
  { id: 'view.presentation', group: 'view', label: 'Saved views and presentation',
    description: 'The Presentation panel and the commands that save a view to it.' },
  { id: 'view.point-clouds', group: 'view', label: 'Point clouds',
    description: 'The Point clouds panel: scan display and deviation against the model.' },

  { id: 'check.compare', group: 'check', label: 'Compare models',
    description: 'The Compare panel: differences between two model revisions.' },
  { id: 'check.bcf', group: 'check', label: 'BCF issues',
    description: 'The BCF panel: topics, comments and viewpoints, including connections to BCF servers.' },
  { id: 'check.validation', group: 'check', label: 'Data validation',
    description: 'The Data validation panel: IDS checks and rule-based information checks.' },
  { id: 'check.ids-authoring', group: 'check', label: 'IDS authoring',
    description: 'The IDS Studio panel for writing IDS documents.' },
  { id: 'check.clash', group: 'check', label: 'Clash detection',
    description: 'The Clash panel.' },
  { id: 'check.review', group: 'check', label: 'Review workspace',
    description: 'The Review panel, which gathers findings from the checking panels.' },
  { id: 'check.load-report', group: 'check', label: 'Load report',
    description: 'The Load report panel: geometry diagnostics for the loaded models.' },

  { id: 'data.lists', group: 'data', label: 'Lists',
    description: 'The Lists panel: tables of elements and their properties.' },
  { id: 'data.charts', group: 'data', label: 'Charts',
    description: 'The Charts panel.' },
  { id: 'data.schedule', group: 'data', label: 'Construction schedule',
    description: 'The Schedule panel (4D) and its commands.' },
  { id: 'data.cost', group: 'data', label: 'Cost',
    description: 'The Cost panel (5D).' },
  { id: 'data.zones', group: 'data', label: 'Location zones',
    description: 'The Zones panel.' },
  { id: 'data.documents', group: 'data', label: 'Documents',
    description: 'The Document panel: report pages built from model data.' },
  { id: 'data.linked-records', group: 'data', label: 'Linked records',
    description: 'The Linked records panel.' },
  { id: 'data.layers', group: 'data', label: 'IFCX layers',
    description: 'The Layers panel for layered IFCX models.' },
  { id: 'data.time-series', group: 'data', label: 'Time series',
    description: 'The time-series panel, which reads sensor data from a database the user connects.' },

  { id: 'edit.model', group: 'edit', label: 'Edit model data',
    description: 'Edit mode and everything behind it: changing properties and attributes, creating, moving and deleting elements, the Model workspace, the Author tab, change sets, and starting a blank model.' },
  { id: 'edit.placement', group: 'edit', label: 'Reposition models',
    description: 'Moving a whole model and editing its georeferencing: the Reposition command and the Placement panel.' },

  { id: 'automate.scripting', group: 'automate', label: 'Scripting',
    description: 'The Script panel and the script templates in the command palette.' },
  { id: 'automate.flows', group: 'automate', label: 'Flows',
    description: 'The Flow panel: node-based automation.' },

  { id: 'automate.extensions', group: 'automate', label: 'Extensions',
    description: 'Installing and running extensions and profiles. When off, installed extensions are not started.' },

  { id: 'ai.assistant', group: 'ai', label: 'AI assistant',
    description: 'Every AI feature: the Assistant panel, the AI chat in the Script panel, "Discuss with AI", the IDS and Flow assistants, extension ideas, the local agent bridge and the AI key settings.' },

  { id: 'collab.sessions', group: 'collab', label: 'Live sessions',
    description: 'Sharing a model in a live session with other people. Also needs a collaboration server configured in the build.' },

  { id: 'export.files', group: 'export', label: 'Export',
    description: 'Saving the model as a file: the export commands in the File tab, the command palette and the element menu, export of a changed model, positioned point cloud and splat downloads, and downloads from scripts and extensions.' },

  { id: 'privacy.analytics', group: 'privacy', label: 'Product analytics',
    description: 'Anonymous usage analytics sent to the analytics service configured in the build, and the setting that lets a user opt out.' },
  { id: 'privacy.vercel-analytics', group: 'privacy', label: 'Hosting analytics script',
    description: 'The page-view analytics script of the hosting platform.' },
  { id: 'privacy.notice', group: 'privacy', label: 'Privacy notice',
    description: 'The first-visit notice about the local action log and hosted analytics.' },
  { id: 'privacy.third-party', group: 'privacy', label: 'Third-party services',
    description: 'Services outside the deployment that the viewer uses on its own: the hosted icon font, map tiles for georeferenced models, the buildingSMART Data Dictionary tab (through the deployment\'s proxy) and the 3D world context.' },

  { id: 'help.tours', group: 'help', label: 'Guided tours',
    description: 'The interactive tours, their invitations and the learning hub.' },
  { id: 'help.product-links', group: 'help', label: 'Product links',
    description: 'Links that lead out of the viewer to the product: the website and the LLM page, and the prompt to star the project.' },
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

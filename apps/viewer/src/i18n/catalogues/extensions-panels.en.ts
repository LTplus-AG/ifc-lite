/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Extensions dock's own panel chrome (#4918 sweep): `AuditLogPanel`,
 * `CapabilityReview`, `IdeasPanel`, `PlanCard`, `PrivacyPanel`,
 * `PromoteToolDialog`, `RepairQueuePanel`, and the widget-DSL renderer
 * (`WidgetRenderer` / `WidgetErrorBoundary`) under `components/extensions/`.
 *
 * Keys are namespaced `extensionsPanels.<component>.<name>` — one section
 * per component below, in the same order as the file list this catalogue
 * was carved out for.
 *
 * Deliberately NOT covered here, same "runtime content, not a literal in
 * this repo" reasoning the rest of the #4918 sweep uses:
 *  - `AuditEvent`/`AuditEventKind` DATA (extension ids, versions, capability
 *    strings, timestamps) — the panel's own kind labels and chrome
 *    ARE catalogued (`auditLogPanel.kind.*`), the event payload is not.
 *  - `STARTER_IDEAS` (`IdeasPanel`) — `idea.plan.summary`/`.rationale`/
 *    `.category`/`.icon` come from the extensions package's registry, not
 *    a literal authored in `IdeasPanel.tsx`.
 *  - `MinedPattern` / `AuthoringPlan` content (pattern sequences, plan
 *    summaries/rationale/contributions/capabilities/triggers/tests) — all
 *    either mined from the user's local activity log or typed by the user
 *    into `PlanCard`'s own editable fields; never authored copy here.
 *  - `WidgetNode` fields (`label`, `text`, `heading`, `body`, `message`,
 *    column/tab titles, …) rendered by `WidgetRenderer` — these come from
 *    an extension's widget DSL payload at runtime, not this file.
 *  - `RevalidationItem`/manifest data in `RepairQueuePanel` (extension ids,
 *    declared engine ranges, test names/errors; compatibility explanations
 *    are catalogue-backed) and the synthesised
 *    manifest's own `description`/`name` fields in `PromoteToolDialog` —
 *    generated/stored content, not UI copy.
 *  - `ICON_CHOICES` labels (`./icon-registry`) — a separate module outside
 *    this file list; not touched here.
 *
 * `APPROVE_PHRASE` in `CapabilityReview` stays the hardcoded English security
 * token `'approve'`. It is interpolated into translated instruction/ARIA copy,
 * so every locale tells the user the exact token the validator accepts.
 */
export const extensionsPanelsEn = {
  // ── AuditLogPanel ──
  'extensionsPanels.auditLogPanel.title': 'Audit Log',
  'extensionsPanels.auditLogPanel.eventCount': {
    one: '{filtered} of {total} event',
    other: '{filtered} of {total} events',
  },
  'extensionsPanels.auditLogPanel.helpLabel': 'Audit log',
  'extensionsPanels.auditLogPanel.helpIntro':
    'Append-only ledger of every extension lifecycle event: install, update, enable, disable, activate, capability grant/revoke, runtime failures.',
  'extensionsPanels.auditLogPanel.helpPersistence':
    'Persists in IndexedDB across reloads. Filter by event kind via the chips below; when multiple extensions are installed, a second chip row scopes by extension id.',
  'extensionsPanels.auditLogPanel.helpExport': '{export} downloads a JSON snapshot.',
  'extensionsPanels.auditLogPanel.exportButton': 'Export',
  'extensionsPanels.auditLogPanel.exportAriaLabel': 'Export audit log',
  'extensionsPanels.auditLogPanel.clearButton': 'Clear',
  'extensionsPanels.auditLogPanel.clearAriaLabel': 'Clear audit log',
  'extensionsPanels.auditLogPanel.closeAriaLabel': 'Close audit log',
  'extensionsPanels.auditLogPanel.filterAll': 'All',
  'extensionsPanels.auditLogPanel.extensionFilterLabel': 'Extension:',
  'extensionsPanels.auditLogPanel.emptyState':
    'No events yet. Audit entries appear here when extensions are installed, updated, enabled, disabled, or uninstalled.',
  'extensionsPanels.auditLogPanel.metadataDate': '{date}',
  'extensionsPanels.auditLogPanel.metadataVersion': '{date} · v{version}',
  'extensionsPanels.auditLogPanel.metadataDetail': '{date} · {detail}',
  'extensionsPanels.auditLogPanel.metadataVersionDetail': '{date} · v{version} · {detail}',
  'extensionsPanels.auditLogPanel.capabilityGrants': {
    one: '{countDisplay} capability grant',
    other: '{countDisplay} capability grants',
  },
  'extensionsPanels.auditLogPanel.mutationEntities': {
    one: '{countDisplay} entity',
    other: '{countDisplay} entities',
  },
  'extensionsPanels.auditLogPanel.networkFetch': '{host} ({bytes} bytes)',
  'extensionsPanels.auditLogPanel.reasonSuffix': '{reason}',
  'extensionsPanels.auditLogPanel.exportToast': 'Audit log exported.',
  'extensionsPanels.auditLogPanel.clearConfirm': 'Clear the audit log? This cannot be undone.',
  'extensionsPanels.auditLogPanel.clearToast': 'Audit log cleared.',
  'extensionsPanels.auditLogPanel.kind.install': 'Install',
  'extensionsPanels.auditLogPanel.kind.uninstall': 'Uninstall',
  'extensionsPanels.auditLogPanel.kind.update': 'Update',
  'extensionsPanels.auditLogPanel.kind.enable': 'Enable',
  'extensionsPanels.auditLogPanel.kind.disable': 'Disable',
  'extensionsPanels.auditLogPanel.kind.capability_grant': 'Granted',
  'extensionsPanels.auditLogPanel.kind.capability_revoke': 'Revoked',
  'extensionsPanels.auditLogPanel.kind.activate': 'Activate',
  'extensionsPanels.auditLogPanel.kind.deactivate': 'Deactivate',
  'extensionsPanels.auditLogPanel.kind.mutation_summary': 'Mutations',
  'extensionsPanels.auditLogPanel.kind.network_fetch': 'Fetch',
  'extensionsPanels.auditLogPanel.kind.unhealthy': 'Unhealthy',
  'extensionsPanels.auditLogPanel.kind.killed': 'Killed',

  // ── CapabilityReview ──
  'extensionsPanels.capabilityReview.installTitle': 'Install {id} v{version}?',
  'extensionsPanels.capabilityReview.description':
    'Review the capabilities this extension is requesting. Uncheck any you do not want to grant. Extensions that rely on a denied capability will surface a clear error at runtime instead of running silently with broader scope.',
  'extensionsPanels.capabilityReview.signatureVerifiedTitle': 'Signature verified',
  'extensionsPanels.capabilityReview.signedByLabel': 'Signed by {fingerprint} · {date}',
  'extensionsPanels.capabilityReview.unsignedTitle': 'Unsigned bundle',
  'extensionsPanels.capabilityReview.unsignedBody':
    'This bundle has no signature. We cannot verify it came from a specific publisher — install only if you trust the source.',
  'extensionsPanels.capabilityReview.capabilityChangesSince': 'Capability changes since {version}',
  'extensionsPanels.capabilityReview.previousVersionFallback': 'the previous version',
  'extensionsPanels.capabilityReview.newLabel': 'New:',
  'extensionsPanels.capabilityReview.droppedLabel': 'Dropped:',
  'extensionsPanels.capabilityReview.tabsAriaLabel': 'Bundle inspection mode',
  'extensionsPanels.capabilityReview.capabilitiesTab': 'Capabilities',
  'extensionsPanels.capabilityReview.sourceTab': 'Source',
  'extensionsPanels.capabilityReview.noCapabilities':
    'This extension requests no capabilities — viewer-only chrome.',
  'extensionsPanels.capabilityReview.grantAriaLabel': 'Grant capability {raw}',
  'extensionsPanels.capabilityReview.unknownCapabilityDescription':
    'Unknown capability — treated as high-risk.',
  'extensionsPanels.capabilityReview.capability.modelRead':
    'Read entities, properties, and geometry from loaded models.',
  'extensionsPanels.capabilityReview.capability.modelMutate':
    'Modify properties matching the listed pattern.',
  'extensionsPanels.capabilityReview.capability.modelCreate':
    'Create new entities in loaded models.',
  'extensionsPanels.capabilityReview.capability.modelDelete':
    'Delete entities from loaded models.',
  'extensionsPanels.capabilityReview.capability.viewerRead':
    'Read selection, camera, and current section state.',
  'extensionsPanels.capabilityReview.capability.viewerColorize':
    'Apply colors / lens results to the viewport.',
  'extensionsPanels.capabilityReview.capability.viewerIsolate':
    'Hide and show entities in the viewport.',
  'extensionsPanels.capabilityReview.capability.viewerFly': 'Move the viewport camera.',
  'extensionsPanels.capabilityReview.capability.viewerSection': 'Modify section planes.',
  'extensionsPanels.capabilityReview.capability.exportCreate':
    'Produce a downloadable file in the named format.',
  'extensionsPanels.capabilityReview.capability.storageLocal':
    'Read and write per-extension local storage.',
  'extensionsPanels.capabilityReview.capability.networkFetch':
    'Fetch from URLs matching the listed host pattern.',
  'extensionsPanels.capabilityReview.capability.commandInvoke':
    "Invoke other extensions' commands matching the listed id pattern.",
  'extensionsPanels.capabilityReview.capability.uiDock': 'Contribute panels to the dock slots.',
  'extensionsPanels.capabilityReview.capability.uiToolbar':
    'Contribute buttons to the toolbar.',
  'extensionsPanels.capabilityReview.capability.uiContextMenu':
    'Contribute items to context menus.',
  'extensionsPanels.capabilityReview.capability.uiStatusBar':
    'Contribute items to the status bar.',
  'extensionsPanels.capabilityReview.risk.unknownCapability':
    'Unknown capability "{raw}". Treated as high-risk because it is not in the catalogue.',
  'extensionsPanels.capabilityReview.risk.target': '{description} Target: `{target}`.',
  'extensionsPanels.capabilityReview.risk.missingRequiredTarget':
    '{description} (Missing required target — treated as universal.)',
  'extensionsPanels.capabilityReview.risk.universalWildcardTarget':
    '{description} Target: `{target}`. Universal wildcard target — unrestricted scope.',
  'extensionsPanels.capabilityReview.risk.hostPatternWildcard':
    '{description} Target: `{target}`. Host pattern contains a wildcard.',
  'extensionsPanels.capabilityReview.risk.targetPatternWildcard':
    '{description} Target: `{target}`. Target pattern contains a wildcard — risk is elevated.',
  'extensionsPanels.capabilityReview.risk.specificNetworkHost':
    '{description} Target: `{target}`. Access is restricted to a specific host.',
  'extensionsPanels.capabilityReview.riskTier.green': 'Green',
  'extensionsPanels.capabilityReview.riskTier.yellow': 'Yellow',
  'extensionsPanels.capabilityReview.riskTier.red': 'Red',
  'extensionsPanels.capabilityReview.highRiskTitle': 'High-risk capability requested',
  'extensionsPanels.capabilityReview.confirmInstruction': 'Type {phrase} below to confirm.',
  'extensionsPanels.capabilityReview.confirmAriaLabel': 'Type {phrase} to confirm',
  'extensionsPanels.capabilityReview.cancelButton': 'Cancel',
  'extensionsPanels.capabilityReview.installButton': 'Install',

  // ── IdeasPanel ──
  'extensionsPanels.ideasPanel.title': 'Ideas',
  'extensionsPanels.ideasPanel.suggestionsSummary': {
    one: '{countDisplay} suggestion · {events} events',
    other: '{countDisplay} suggestions · {events} events',
  },
  'extensionsPanels.ideasPanel.helpLabel': 'Ideas',
  'extensionsPanels.ideasPanel.helpCuratedSubject': 'Curated starter ideas',
  'extensionsPanels.ideasPanel.helpCurated': '{subject} show what one-click tools you can build today.',
  'extensionsPanels.ideasPanel.helpRecurringSubject': 'Recurring suggestions',
  'extensionsPanels.ideasPanel.helpRecurring':
    '{subject} appear once a workflow shows up repeatedly in your local activity log (model loads, lens applies, exports). Thresholds relax while the log is sparse so something appears early; tightens as data accumulates.',
  'extensionsPanels.ideasPanel.helpActions':
    'Click {tryIt} to send the idea to the AI chat assistant — chat opens and you answer follow-ups. Click {customize} if you want to prune capabilities or rename the command before chat sees it.',
  'extensionsPanels.ideasPanel.helpPrivacy': 'The action log is local. Nothing here leaves your device.',
  'extensionsPanels.ideasPanel.remineAriaLabel': 'Re-mine now',
  'extensionsPanels.ideasPanel.remineButton': 'Re-mine',
  'extensionsPanels.ideasPanel.footerPrivacy':
    'Recurring sequences in your local activity log. Nothing here leaves your device.',
  'extensionsPanels.ideasPanel.recurringHeading': 'Recurring in your activity',
  'extensionsPanels.ideasPanel.occurrenceSummary': {
    one: '{occurrences}× across {sessions} session · last {date} · score {score}',
    other: '{occurrences}× across {sessions} sessions · last {date} · score {score}',
  },
  'extensionsPanels.ideasPanel.acceptMinedAriaLabel': 'Author one-click tool from pattern',
  'extensionsPanels.ideasPanel.authorItButton': 'Author it',
  'extensionsPanels.ideasPanel.gettingStartedEmpty': 'Try one of these to get started',
  'extensionsPanels.ideasPanel.gettingStartedExamples': 'Examples — common AEC tools',
  'extensionsPanels.ideasPanel.customizePlanLink': 'Customize plan first…',
  'extensionsPanels.ideasPanel.sendToChatAriaLabel': 'Send "{summary}" to chat',
  'extensionsPanels.ideasPanel.sendToChatTitle':
    'Sends a plan-based prompt to the AI chat assistant. Opens the chat panel.',
  'extensionsPanels.ideasPanel.tryItButton': 'Try it',
  'extensionsPanels.ideasPanel.authorFromScratchButton': 'Author an extension from scratch',
  'extensionsPanels.ideasPanel.authorFromScratchBody':
    'Open an empty plan. Fill in what you want, then approve → chat AI assembles the bundle.',
  'extensionsPanels.ideasPanel.sentToChatToast': 'Sent "{summary}" to chat — answer follow-ups to refine.',
  'extensionsPanels.ideasPanel.routingToChatToast': 'Routing "{summary}" to the AI assistant…',

  // ── PlanCard ──
  'extensionsPanels.planCard.heading': 'Authoring plan',
  'extensionsPanels.planCard.summaryAriaLabel': 'Plan summary',
  'extensionsPanels.planCard.contributionsLabel': 'Contributions',
  'extensionsPanels.planCard.noContributions': 'No contributions.',
  'extensionsPanels.planCard.removeContributionAriaLabel': 'Remove contribution {index}',
  'extensionsPanels.planCard.capabilitiesLabel': 'Capabilities',
  'extensionsPanels.planCard.noCapabilitiesRequested': 'No capabilities requested.',
  'extensionsPanels.planCard.toggleCapabilityAriaLabel': 'Toggle capability {raw}',
  'extensionsPanels.planCard.triggersLabel': 'Triggers',
  'extensionsPanels.planCard.testsLabel': 'Tests',
  'extensionsPanels.planCard.fixtureLabel': 'Fixture:',
  'extensionsPanels.planCard.cancelButton': 'Cancel',
  'extensionsPanels.planCard.authorItButton': 'Author it',

  // ── PrivacyPanel ──
  'extensionsPanels.privacyPanel.title': 'Privacy',
  'extensionsPanels.privacyPanel.helpLabel': 'Privacy',
  'extensionsPanels.privacyPanel.helpIntro':
    'IFClite keeps a content-free action log of intents you perform (model loads, lens applies, exports) — used by the pattern miner to suggest one-click tools. The log never records model content, chat content, file names, or API keys.',
  'extensionsPanels.privacyPanel.helpOverlay':
    'The prompt overlay on the active profile is appended to every chat system prompt — use it for stable preferences. Extract from chat scans the current session for explicit preferences and proposes them.',
  'extensionsPanels.privacyPanel.extractFromChat': 'Extract from chat',
  'extensionsPanels.privacyPanel.storeHeading': 'What we store locally',
  'extensionsPanels.privacyPanel.storeBody1':
    'ifc-lite keeps a content-free action log of the high-level intents you perform (model loads, lens applies, exports). We use it to mine recurring patterns and surface one-click tool suggestions. The log never records model content, chat content, file names, or API keys.',
  'extensionsPanels.privacyPanel.storeBody2':
    "Suggestions, the audit log, the prompt overlay, and your profile library are all stored in your browser's IndexedDB — nothing here is sent off device unless you explicitly export.",
  'extensionsPanels.privacyPanel.actionLogHeading': 'Action log',
  'extensionsPanels.privacyPanel.actionLogStats': '{events} events · {kib} KiB',
  'extensionsPanels.privacyPanel.exportJsonButton': 'Export JSON',
  'extensionsPanels.privacyPanel.clearButton': 'Clear',
  'extensionsPanels.privacyPanel.overlayHeading': 'Prompt overlay',
  'extensionsPanels.privacyPanel.overlayIntro':
    'Notes appended to the AI assistant’s system prompt for the active profile. Use it for stable preferences ("write CSV exports with semicolons", "default to red color for IfcWall"). Capped at ~4000 tokens.',
  'extensionsPanels.privacyPanel.noActiveFlavor':
    'No active profile. Activate or import one to attach overlay notes to it.',
  'extensionsPanels.privacyPanel.editingOverlayFor': 'Editing overlay for {name}',
  'extensionsPanels.privacyPanel.overlayPlaceholder':
    'e.g. Always export CSV with semicolon separators. Default lens for IfcWall: by-fire-rating.',
  'extensionsPanels.privacyPanel.approxTokens': '{tokens} approx tokens',
  'extensionsPanels.privacyPanel.saveOverlayButton': 'Save overlay',
  'extensionsPanels.privacyPanel.candidatePreferenceCount': {
    one: '{countDisplay} candidate preference',
    other: '{countDisplay} candidate preferences',
  },
  'extensionsPanels.privacyPanel.ruleBasedWarning':
    'Rule-based scan — review each line before saving. The extractor uses a heuristic blocklist; it is not a guarantee that no content slips through.',
  'extensionsPanels.privacyPanel.discardButton': 'Discard',
  'extensionsPanels.privacyPanel.addToOverlayButton': 'Add to overlay',
  'extensionsPanels.privacyPanel.exportLogToast': 'Action log exported.',
  'extensionsPanels.privacyPanel.clearLogConfirm':
    'Clear the local action log? Suggestions reset until you build up new patterns.',
  'extensionsPanels.privacyPanel.clearLogToast': 'Action log cleared.',
  'extensionsPanels.privacyPanel.noPreferencesToast': 'No stable preferences detected in this session yet.',
  'extensionsPanels.privacyPanel.foundPreferencesToast': {
    one: 'Found {countDisplay} candidate preference.',
    other: 'Found {countDisplay} candidate preferences.',
  },
  'extensionsPanels.privacyPanel.addedPreferencesToast': {
    one: 'Added {countDisplay} preference to the overlay. Save to keep them.',
    other: 'Added {countDisplay} preferences to the overlay. Save to keep them.',
  },
  'extensionsPanels.privacyPanel.noActiveFlavorError': 'No active profile — switch to one before editing its overlay.',
  'extensionsPanels.privacyPanel.overlayClampedToast': 'Overlay clamped to ~{tokens} tokens.',
  'extensionsPanels.privacyPanel.overlaySavedToast': 'Overlay saved ({tokens} tokens).',
  'extensionsPanels.privacyPanel.saveFailedToast': 'Save failed: {error}',

  // ── PromoteToolDialog ──
  'extensionsPanels.promoteToolDialog.title': 'Promote script to a tool',
  'extensionsPanels.promoteToolDialog.description':
    'Turn this saved script into a persistent, sandboxed tool. The tool appears in the command palette and on the toolbar. It runs in the same sandbox as your scripts with only the capabilities you grant.',
  'extensionsPanels.promoteToolDialog.nameLabel': 'Name',
  'extensionsPanels.promoteToolDialog.defaultName': 'My tool',
  'extensionsPanels.promoteToolDialog.namePlaceholder': 'Fire-rating report',
  'extensionsPanels.promoteToolDialog.hotkeyLabel': 'Hotkey (optional)',
  'extensionsPanels.promoteToolDialog.hotkeyPlaceholder': 'Ctrl+Alt+F',
  'extensionsPanels.promoteToolDialog.iconLabel': 'Icon',
  'extensionsPanels.promoteToolDialog.iconGroupAriaLabel': 'Pick a toolbar icon',
  'extensionsPanels.promoteToolDialog.inferredCapabilitiesHeading': 'Inferred capabilities',
  'extensionsPanels.promoteToolDialog.noCapabilitiesDetected':
    'No `bim.*` calls detected. The tool will request only {capability}.',
  'extensionsPanels.promoteToolDialog.unknownCallsWarning':
    'Unknown `bim.*` calls detected — review the source before approving.',
  'extensionsPanels.promoteToolDialog.parseErrorWarning': 'Script does not parse cleanly — promotion may fail.',
  'extensionsPanels.promoteToolDialog.cancelButton': 'Cancel',
  'extensionsPanels.promoteToolDialog.reviewInstallButton': 'Review & install',
  'extensionsPanels.promoteToolDialog.packageFailedToast': 'Failed to package tool: {error}',
  'extensionsPanels.promoteToolDialog.installedWithHotkey':
    'Installed "{name}". It’s now a button in the toolbar (top-right) — or press {hotkey}.',
  'extensionsPanels.promoteToolDialog.installedNoHotkey':
    'Installed "{name}". It’s now a button in the toolbar (top-right).',
  'extensionsPanels.promoteToolDialog.installRejectedToast': 'Install rejected: {message}',
  'extensionsPanels.promoteToolDialog.installFailedToast': 'Install failed: {error}',

  // ── RepairQueuePanel ──
  'extensionsPanels.repairQueuePanel.title': 'Repair queue',
  'extensionsPanels.repairQueuePanel.summaryLine': {
    one: 'SDK {sdk} · {countDisplay} needs fixing',
    other: 'SDK {sdk} · {countDisplay} need fixing',
  },
  'extensionsPanels.repairQueuePanel.helpLabel': 'Repair queue',
  'extensionsPanels.repairQueuePanel.helpIntro':
    'When the viewer SDK bumps, extensions whose declared {engineRange} range no longer matches are flagged here.',
  'extensionsPanels.repairQueuePanel.runCheckLabel': 'Run check',
  'extensionsPanels.repairQueuePanel.repairLabel': 'Repair',
  'extensionsPanels.repairQueuePanel.helpActions':
    '{runCheck} spins up a sandbox for each outdated extension and runs its manifest tests against the new SDK. Failing tests get a {repair} button that seeds chat with a fix prompt — the AI authoring loop produces the patched bundle.',
  'extensionsPanels.repairQueuePanel.helpNoAuto': "Doesn't run automatically (each check spawns sandboxes).",
  'extensionsPanels.repairQueuePanel.rerunButton': 'Re-run',
  'extensionsPanels.repairQueuePanel.closeAriaLabel': 'Close',
  'extensionsPanels.repairQueuePanel.sdkUnknown': 'SDK version unknown — cannot revalidate. Set {appVersion} via Vite define.',
  'extensionsPanels.repairQueuePanel.noCheckRun': 'No compatibility check has run for this session.',
  'extensionsPanels.repairQueuePanel.noInstalledExtensions': 'No installed extensions',
  'extensionsPanels.repairQueuePanel.rangeLabel': 'Range {range} · {reason}',
  'extensionsPanels.repairQueuePanel.outcome.pass': 'Pass',
  'extensionsPanels.repairQueuePanel.outcome.fail': 'Fail',
  'extensionsPanels.repairQueuePanel.outcome.skipped': 'Skipped',
  'extensionsPanels.repairQueuePanel.compatibility.invalidSdkVersion':
    'Could not parse SDK version "{sdk}".',
  'extensionsPanels.repairQueuePanel.compatibility.unsupportedRange':
    'Range too loose to evaluate — re-run tests to confirm.',
  'extensionsPanels.repairQueuePanel.compatibility.rangeMismatch':
    'Range "{declared}" no longer matches SDK {sdk}.',
  'extensionsPanels.repairQueuePanel.compatibility.rangeMatch':
    'Range "{declared}" still matches SDK {sdk}.',
  'extensionsPanels.repairQueuePanel.testsFailed': {
    one: '{countDisplay} test failed: {error}',
    other: '{countDisplay} tests failed: {error}',
  },
  'extensionsPanels.repairQueuePanel.routingRepairToast': 'Routing repair for {extensionId}…',
  'extensionsPanels.repairQueuePanel.revalidationFailedToast': 'Revalidation failed: {error}',

  // ── Widget DSL renderer (WidgetErrorBoundary / WidgetRenderer) ──
  'extensionsPanels.widgetErrorBoundary.crashed': '{label} crashed while rendering',
  'extensionsPanels.widgetRenderer.noRows': 'No rows',
  'extensionsPanels.widgetRenderer.chartLabel': '{variant} chart',
  'extensionsPanels.widgetRenderer.chartVariant.bar': 'Bar',
  'extensionsPanels.widgetRenderer.chartVariant.line': 'Line',
  'extensionsPanels.widgetRenderer.chartVariant.pie': 'Pie',
  'extensionsPanels.widgetRenderer.retryButton': 'Retry',
  'extensionsPanels.widgetRenderer.noEntities': 'No entities',
  'extensionsPanels.widgetRenderer.unknownNodeLabel': 'Unknown widget node: {type}',
} as const satisfies Record<string, TranslationValue>;

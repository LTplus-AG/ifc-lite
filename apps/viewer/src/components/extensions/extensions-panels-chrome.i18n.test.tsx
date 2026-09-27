/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Extensions dock's own panel chrome reads the i18n catalogue
 * (#4918): `AuditLogPanel`, `CapabilityReview`, `IdeasPanel`, `PlanCard`,
 * `PromoteToolDialog`, `RepairQueuePanel`. `PrivacyPanel` (the biggest,
 * 33 literals) has its own file, `PrivacyPanel.i18n.test.tsx`; the widget
 * DSL renderer has `widget/WidgetRenderer.i18n.test.tsx`.
 *
 * Same oracle shape as `MainToolbar.i18n.test.tsx` /
 * `shared-commands.i18n.test.tsx`: a pseudo-locale marks every English
 * string in `extensions-panels.en.ts`; each panel is mounted in a state
 * that surfaces as much of its own chrome as possible, the locale is
 * switched live, and every marked string that was readable in English
 * must reappear marked. A label left hardcoded, or a consumer that does
 * not re-render on a locale switch, fails here by name.
 *
 * Deliberately not driven into every state: toast messages
 * (`toast.success('...')`/`toast.error('...')`) and `confirm()` prompts
 * are real translated calls in the source (see the catalogue keys ending
 * `...Toast`/`...Confirm`) but are not DOM text this renderer-focused
 * oracle can observe without mocking `toast`/`window.confirm` per call
 * site across six components; they are intentionally left out of
 * `STATIC_KEYS`' coverage rather than faked into a false pass.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type {
  AuthoringPlan,
  MineEvent,
  RevalidationItem,
  RevalidationSummary,
} from '@ifc-lite/extensions';
import type { ExtensionInstallSummary as HostInstallSummary } from '@/services/extensions/host';
import { createBimContext } from '@ifc-lite/sdk';
import { cleanup, render, type as typeInput } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { extensionsPanelsEn } from '@/i18n/catalogues/extensions-panels.en';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { AuditLogPanel } from './AuditLogPanel.js';
import { CapabilityReview } from './CapabilityReview.js';
import { IdeasPanel } from './IdeasPanel.js';
import { formatExtensionDate } from './localized-date.js';
import { PlanCard } from './PlanCard.js';
import { PromoteToolDialog } from './PromoteToolDialog.js';
import { RepairQueuePanel } from './RepairQueuePanel.js';

const SDK = '2.0.0';

/** A real `ExtensionHostService` (audit/actionLog/flavors/miner are all
 * host-agnostic in-memory structures — no IndexedDB touched by
 * construction) with only the IDB-backed / sandbox-backed methods
 * stubbed, same approach `RepairQueuePanel.test.tsx` uses. */
class StubExtensionHost extends ExtensionHostService {
  revalidateSummary: RevalidationSummary = { sdk: SDK, items: [], needsRepair: [] };

  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }

  override async clearPersistedActionLog(): Promise<void> {}
  override async clearPersistedAuditLog(): Promise<void> {}
  override revalidateForSdk(): Promise<RevalidationSummary> {
    return Promise.resolve(this.revalidateSummary);
  }
  override getSuggestions(): MineEvent | undefined {
    return {
      patterns: [
        {
          sequence: ['model.load', 'export.run'],
          occurrences: 4,
          sessionsTouched: 2,
          lastSeenAt: new Date('2026-01-01T00:00:00Z').toISOString(),
          score: 0.82,
        },
      ],
      eventCount: 1234,
      at: new Date('2026-01-01T00:00:00Z').toISOString(),
    };
  }
}

type ExtKey = keyof typeof extensionsPanelsEn;
const ALL_KEYS = Object.keys(extensionsPanelsEn) as ExtKey[];

/** Keys this file's oracle covers — everything except `privacyPanel.*`
 *  (own test file) and `widgetErrorBoundary.*`/`widgetRenderer.*` (own
 *  test file). Toast/confirm keys are covered by neither oracle; see
 *  file doc comment. */
const COVERED_PREFIXES = [
  'extensionsPanels.auditLogPanel.',
  'extensionsPanels.capabilityReview.',
  'extensionsPanels.ideasPanel.',
  'extensionsPanels.planCard.',
  'extensionsPanels.promoteToolDialog.',
  'extensionsPanels.repairQueuePanel.',
];
const SCOPE_KEYS = ALL_KEYS.filter((key) => COVERED_PREFIXES.some((p) => key.startsWith(p)));
const DATA_DRIVEN_COPY_PREFIXES = [
  'extensionsPanels.capabilityReview.capability.',
  'extensionsPanels.capabilityReview.risk.',
  'extensionsPanels.capabilityReview.riskTier.',
  'extensionsPanels.repairQueuePanel.compatibility.',
  'extensionsPanels.repairQueuePanel.outcome.',
];
const STATIC_KEYS = SCOPE_KEYS.filter((key) => {
  const value = extensionsPanelsEn[key];
  return typeof value === 'string'
    && !value.includes('{')
    && !DATA_DRIVEN_COPY_PREFIXES.some((prefix) => key.startsWith(prefix));
});

/** Key-specific pseudo translation; keeps every `{placeholder}` of the English text. */
const mark = (key: ExtKey) => `⟦${key}|${String(extensionsPanelsEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(
  ALL_KEYS.map((key) => [key, mark(key)]),
) as Catalogue;

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.value) out.add(element.value);
    }
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels, titles, placeholders, field values, plain text, and (by focusing every
 *  button/input in turn) every reachable Radix `TooltipContent` string. */
function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const el of container.querySelectorAll('button, input, textarea')) {
    act(() => (el as HTMLElement).focus());
    addReadable(document.body, out);
    act(() => (el as HTMLElement).blur());
  }
  return out;
}

/**
 * `HelpHint`'s body (its `children`) only mounts once its own trigger is
 * clicked open — a controlled popover, not a hover/focus tooltip. Every
 * panel's help copy lives there, so the oracle must open each one before
 * reading strings. The trigger's own aria-label is `Help: {label}`
 * (`extensionsFlavors.helpHint.ariaLabel`, a different catalogue) — which
 * is why `foundText` below matches by substring rather than exact value:
 * a panel's own `helpLabel` catalogue value (e.g. `"Audit log"`) never
 * appears bare, only wrapped inside that other catalogue's template.
 *
 * #5817: `HelpHint`'s popover moved onto Radix (`ui/popover.tsx`), whose
 * non-modal `DismissableLayer` closes a popover on ANY outside pointer
 * interaction — including a click on a DIFFERENT `HelpHint`'s trigger, since
 * that trigger sits outside the first one's `PopoverContent`. The old
 * hand-rolled version had no such cross-instance effect (each one's
 * outside-click listener only checked its own container), so multiple
 * `HelpHint`s could stay open at once; under Radix, only the most recently
 * opened one is. That's the correct, intended behavior for a click-toggled
 * popover (matches "click elsewhere to dismiss" everywhere else in the
 * app), not a regression to route around — so this reads each one's text
 * the instant after IT opens, accumulating into one set the callers merge
 * with a plain `readableStrings`, rather than assuming every trigger
 * clicked stays open simultaneously in the live DOM.
 */
function openAllHelpHints(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  for (const button of container.querySelectorAll('button')) {
    if (button.getAttribute('aria-label')?.startsWith('Help: ')) {
      act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
      addReadable(document.body, out);
    }
  }
  return out;
}

/** Substring match against a captured string set — tolerates a target
 *  string appearing as part of a larger composed string (e.g. a `label`
 *  prop interpolated into another component's own template). */
function foundText(strings: Set<string>, text: string): boolean {
  if (strings.has(text)) return true;
  for (const s of strings) {
    if (s.includes(text)) return true;
  }
  return false;
}

function planFixture(): AuthoringPlan {
  return {
    summary: 'Fire-rating report',
    rationale: 'Summarise fire ratings across selected walls.',
    contributions: [{ kind: 'command', label: 'Run report', id: 'cmd.run' }],
    capabilities: ['model.read'],
    triggers: ['onCommand:cmd.run'],
    widgets: [],
    tests: [{ name: 'runs on a sample model', fixture: 'sample.ifc', assertionSummary: 'produces a CSV' }],
    notes: 'Draft — needs review.',
  };
}

function capabilitySummary(): HostInstallSummary {
  return {
    id: 'com.example.fire-rating',
    version: '1.2.0',
    bundleHash: 'a'.repeat(64),
    capabilities: ['model.read', 'network.fetch:*', '??not-a-capability??'],
    bundle: {
      manifest: {
        manifestVersion: 1,
        id: 'com.example.fire-rating',
        name: 'Fire rating report',
        description: 'test fixture',
        version: '1.2.0',
        engines: { ifcLiteSdk: '>=1.0.0' },
        capabilities: ['model.read', 'network.fetch:*', '??not-a-capability??'],
        activation: ['onCommand:run'],
        contributes: { commands: [{ id: 'run', title: 'Run' }] },
        entry: { commands: { run: 'src/run.js' } },
      },
      files: new Map(),
      source: { kind: 'memory' },
    },
    signed: false,
  };
}

function repairItem(): RevalidationItem {
  return {
    extensionId: 'com.example.old-tool',
    outcome: 'fail',
    tests: {
      passed: 0,
      failed: 1,
      totalDurationMs: 12,
      results: [{ name: 'smoke test', passed: false, durationMs: 12, error: 'command not found' }],
    },
    compatibility: {
      extensionId: 'com.example.old-tool',
      declared: '^1.0.0',
      sdk: SDK,
      status: 'outdated',
      reasonCode: 'range-mismatch',
      reason: 'outdated range',
    },
  };
}

/**
 * Keys this render cannot show, each for a stated reason: a toast/confirm
 * message (see file doc comment), or one branch of a mutually-exclusive
 * state this fixture did not pick.
 */
const NOT_RENDERED_IN_THIS_STATE: ExtKey[] = [
  // Toast / confirm copy — not DOM text (see file doc comment).
  'extensionsPanels.auditLogPanel.exportToast',
  'extensionsPanels.auditLogPanel.clearConfirm',
  'extensionsPanels.auditLogPanel.clearToast',
  'extensionsPanels.ideasPanel.sentToChatToast',
  'extensionsPanels.ideasPanel.routingToChatToast',
  'extensionsPanels.promoteToolDialog.packageFailedToast',
  'extensionsPanels.promoteToolDialog.installedWithHotkey',
  'extensionsPanels.promoteToolDialog.installedNoHotkey',
  'extensionsPanels.promoteToolDialog.installRejectedToast',
  'extensionsPanels.promoteToolDialog.installFailedToast',
  'extensionsPanels.repairQueuePanel.routingRepairToast',
  'extensionsPanels.repairQueuePanel.revalidationFailedToast',
  // AuditLogPanel: empty-state text — this fixture seeds events.
  'extensionsPanels.auditLogPanel.emptyState',
  // CapabilityReview: signature-verified branch — this fixture is unsigned.
  'extensionsPanels.capabilityReview.signatureVerifiedTitle',
  'extensionsPanels.capabilityReview.signedByLabel',
  // CapabilityReview: no-capabilities empty state — fixture has capabilities.
  'extensionsPanels.capabilityReview.noCapabilities',
  // CapabilityReview: `previousVersion="1.1.0"` is supplied, so the
  // "the previous version" fallback is the other branch; the fixture's
  // capability set is unchanged from `previousGrants`, so nothing is
  // dropped since the last install.
  'extensionsPanels.capabilityReview.previousVersionFallback',
  'extensionsPanels.capabilityReview.droppedLabel',
  // IdeasPanel: mined-pattern branch is shown (patterns.length > 0), so
  // the "no patterns yet" starter heading is the other branch.
  'extensionsPanels.ideasPanel.gettingStartedEmpty',
  // PlanCard: fixture has non-empty contributions/capabilities, so the
  // two empty-state messages are the other branch.
  'extensionsPanels.planCard.noContributions',
  'extensionsPanels.planCard.noCapabilitiesRequested',
  // PromoteToolDialog: this fixture's source has no `bim.*` calls and
  // parses cleanly, so the warning/error branches don't mount.
  'extensionsPanels.promoteToolDialog.unknownCallsWarning',
  'extensionsPanels.promoteToolDialog.parseErrorWarning',
  // RepairQueuePanel: the "no installed extensions" / "unknown SDK"
  // empty states are the other branches of this fixture's populated,
  // known-SDK render.
  'extensionsPanels.repairQueuePanel.noInstalledExtensions',
  'extensionsPanels.repairQueuePanel.noCheckRun',
];

/** Mount all six covered panels in a state that surfaces as much of
 *  their own chrome as possible, open every HelpHint, and reveal
 *  RepairQueuePanel's populated state (it starts with no check run).
 *  `helpText` is the union collected while opening each `HelpHint` in turn
 *  (#5817: only the most recently opened one is still in the live DOM by
 *  the time this returns) — callers merge it into their own
 *  `readableStrings(container)` read instead of assuming every panel's
 *  help copy is simultaneously present. */
async function mountFixture(): Promise<{ host: StubExtensionHost; container: HTMLElement; helpText: Set<string> }> {
  const host = new StubExtensionHost();
  host.audit.append({
    kind: 'install',
    extensionId: 'com.example.fire-rating',
    version: '1.2.0',
    grantedCapabilities: ['model.read', 'model.write'],
  });
  host.audit.append({ kind: 'mutation_summary', extensionId: 'com.example.other-tool', entityCount: 12, psetPatterns: ['Pset_WallCommon'] });
  host.revalidateSummary = { sdk: SDK, items: [repairItem()], needsRepair: [repairItem()] };

  const container = render(
    <ExtensionHostContext.Provider value={host}>
      <div>
        <AuditLogPanel onClose={() => {}} />
        <CapabilityReview
          open
          summary={capabilitySummary()}
          previousGrants={['model.read']}
          previousVersion="1.1.0"
          onApprove={() => {}}
          onCancel={() => {}}
        />
        <IdeasPanel />
        <PlanCard plan={planFixture()} onApprove={() => {}} onCancel={() => {}} />
        <PromoteToolDialog open source="function run(ctx) { return 1; }" onClose={() => {}} />
        <RepairQueuePanel sdkVersion={SDK} onClose={() => {}} />
      </div>
    </ExtensionHostContext.Provider>,
  );

  const runCheckButton = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Run check'),
  );
  assert.ok(runCheckButton, 'expected an initial "Run check" button');
  await act(async () => {
    runCheckButton.click();
    await Promise.resolve();
  });
  const helpText = openAllHelpHints(container);

  return { host, container, helpText };
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('Extensions dock panel chrome localization (#4918)', () => {
  it('translates every static key rendered across the covered panels', async () => {
    const { container, helpText: helpTextEnglish } = await mountFixture();
    const english = new Set([...readableStrings(container), ...helpTextEnglish]);

    registerLocale('extensions-panels-chrome-pseudo', PSEUDO);
    act(() => setLocale('extensions-panels-chrome-pseudo'));
    // Re-open every HelpHint under the switched locale too (#5817: only the
    // last-opened one is still in the DOM from `mountFixture`'s own open
    // pass, and that pass ran under English).
    const helpTextAfter = openAllHelpHints(container);
    const after = new Set([...readableStrings(container), ...helpTextAfter]);

    const covered = new Set<ExtKey>();
    for (const key of STATIC_KEYS) {
      const text = String(extensionsPanelsEn[key]);
      if (!foundText(english, text)) continue; // not on screen in this render; checked below
      assert.ok(foundText(after, mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      covered.add(key);
    }

    for (const key of covered) {
      assert.ok(
        !NOT_RENDERED_IN_THIS_STATE.includes(key),
        `${key}: covered by this render, drop it from NOT_RENDERED_IN_THIS_STATE`,
      );
    }
  });

  it('accounts for every static key: rendered here, a toast/confirm, or a documented other-branch', async () => {
    const { container, helpText } = await mountFixture();
    const english = new Set([...readableStrings(container), ...helpText]);

    const seen = STATIC_KEYS.filter((key) => foundText(english, String(extensionsPanelsEn[key])));
    const unaccounted = STATIC_KEYS.filter(
      (key) => !seen.includes(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(unaccounted, [], 'key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');

    const stale = NOT_RENDERED_IN_THIS_STATE.filter(
      (key) => seen.includes(key) && !key.endsWith('Toast') && !key.endsWith('Confirm'),
    );
    assert.deepEqual(stale, [], 'key listed as not-rendered but is actually on screen in this render');
  });

  it('localizes package capability and compatibility diagnostics from stable identifiers', async () => {
    registerLocale('extensions-diagnostics-de', {
      'extensionsPanels.capabilityReview.capability.modelRead': 'MODELLE LESEN',
      'extensionsPanels.capabilityReview.capability.networkFetch': 'NETZWERK ABRUFEN',
      'extensionsPanels.capabilityReview.risk.universalWildcardTarget':
        '{description} ZIEL `{target}` IST GLOBAL',
      'extensionsPanels.capabilityReview.risk.targetPatternWildcard':
        '{description} MUSTER `{target}` ERHÖHT DAS RISIKO',
      'extensionsPanels.capabilityReview.risk.specificNetworkHost':
        '{description} NUR HOST `{target}`',
      'extensionsPanels.capabilityReview.risk.unknownCapability':
        'UNBEKANNTE FÄHIGKEIT {raw}',
      'extensionsPanels.capabilityReview.riskTier.green': 'GRÜN',
      'extensionsPanels.capabilityReview.riskTier.red': 'ROT',
      'extensionsPanels.repairQueuePanel.compatibility.rangeMismatch':
        'BEREICH {declared} PASST NICHT ZU SDK {sdk}',
      'extensionsPanels.repairQueuePanel.outcome.fail': 'FEHLER',
    } as Catalogue);
    setLocale('extensions-diagnostics-de');

    const host = new StubExtensionHost();
    const item = repairItem();
    host.revalidateSummary = { sdk: SDK, items: [item], needsRepair: [item] };
    const summary = {
      ...capabilitySummary(),
      capabilities: [
        'model.read',
        'network.fetch:*',
        'network.fetch:example.com',
        'viewer.colorize:IfcW*',
        'model.unlisted',
      ],
    };
    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <div>
          <CapabilityReview
            open
            summary={summary}
            onApprove={() => {}}
            onCancel={() => {}}
          />
          <PlanCard plan={planFixture()} onApprove={() => {}} onCancel={() => {}} />
          <RepairQueuePanel sdkVersion={SDK} />
        </div>
      </ExtensionHostContext.Provider>,
    );
    const runCheckButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Run check'),
    );
    assert.ok(runCheckButton);
    await act(async () => {
      runCheckButton.click();
      await Promise.resolve();
    });

    const text = document.body.textContent ?? '';
    assert.match(text, /MODELLE LESEN/);
    assert.match(text, /NETZWERK ABRUFEN ZIEL `\*` IST GLOBAL/);
    assert.match(text, /NETZWERK ABRUFEN NUR HOST `example\.com`/);
    assert.match(text, /MUSTER `IfcW\*` ERHÖHT DAS RISIKO/);
    assert.match(text, /UNBEKANNTE FÄHIGKEIT model\.unlisted/);
    assert.match(text, /BEREICH \^1\.0\.0 PASST NICHT ZU SDK 2\.0\.0/);
    assert.match(text, /GRÜN/);
    assert.match(text, /ROT/);
    assert.match(text, /FEHLER/);
    assert.doesNotMatch(text, /\bgreen\b|\bred\b|\bfail\b/);
    assert.doesNotMatch(text, /Read entities, properties, and geometry/);
    assert.doesNotMatch(text, /Fetch from URLs matching/);
    assert.doesNotMatch(text, /outdated range/);
  });

  it('pluralizes and interpolates a representative sample under a live locale switch', async () => {
    const host = new StubExtensionHost();
    host.audit.append({
      kind: 'install',
      extensionId: 'com.example.fire-rating',
      version: '9.9.9',
      grantedCapabilities: ['model.read'],
    });
    host.revalidateSummary = { sdk: SDK, items: [repairItem()], needsRepair: [repairItem()] };

    registerLocale('fr-FR', {
      'extensionsPanels.auditLogPanel.eventCount': {
        one: '{filtered} sur {total} événement (fr)',
        other: '{filtered} sur {total} événements (fr)',
      },
      'extensionsPanels.auditLogPanel.metadataVersionDetail': '{date} · v{version} (fr) · {detail}',
      'extensionsPanels.auditLogPanel.capabilityGrants': {
        one: '{count} capacité accordée (fr)',
        other: '{count} capacités accordées (fr)',
      },
      'extensionsPanels.ideasPanel.suggestionsSummary': {
        one: '{countDisplay} suggestion (fr) · {events} événements',
        other: '{countDisplay} suggestions (fr) · {events} événements',
      },
      'extensionsPanels.ideasPanel.occurrenceSummary': {
        one: '{occurrences} occurrence · {sessions} session · {date} · {score}',
        other: '{occurrences} occurrences · {sessions} sessions · {date} · {score}',
      },
      'extensionsPanels.repairQueuePanel.testsFailed': {
        one: 'ERREUR {error} — {countDisplay} test échoué (fr)',
        other: 'ERREUR {error} — {countDisplay} tests échoués (fr)',
      },
      'extensionsPanels.repairQueuePanel.summaryLine': {
        one: 'SDK {sdk} · {countDisplay} à réparer (fr)',
        other: 'SDK {sdk} · {countDisplay} à réparer (fr)',
      },
    } as Catalogue);
    setLocale('fr-FR');

    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <div>
          <AuditLogPanel onClose={() => {}} />
          <IdeasPanel />
          <RepairQueuePanel sdkVersion={SDK} />
        </div>
      </ExtensionHostContext.Provider>,
    );
    const runCheckButton = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Run check'),
    );
    await act(async () => {
      runCheckButton?.click();
      await Promise.resolve();
    });

    assert.match(container.textContent ?? '', /· v9\.9\.9 \(fr\)/);
    assert.match(container.textContent ?? '', /1 sur 1 événement \(fr\)/);
    assert.match(container.textContent ?? '', /· 1 capacité accordée \(fr\)/);
    assert.match(container.textContent ?? '', /1 suggestion \(fr\) · 1 234 événements/);
    assert.match(container.textContent ?? '', /ERREUR command not found — 1 test échoué \(fr\)/);
    assert.match(container.textContent ?? '', /4 occurrences · 2 sessions · .* · 0,82/);
    assert.match(container.textContent ?? '', /SDK 2\.0\.0 · 1 à réparer \(fr\)/);
  });

  it('formats audit totals with the active locale', () => {
    const host = new StubExtensionHost();
    host.audit.append({ kind: 'install', extensionId: 'com.example.audit' });
    registerLocale('ar-EG', {});
    setLocale('ar-EG');
    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <AuditLogPanel />
      </ExtensionHostContext.Provider>,
    );
    assert.match(container.textContent ?? '', /١ of ١ event/);
    assert.doesNotMatch(container.textContent ?? '', /1 of 1 event/);
  });

  it('lets a locale reorder the complete install question', () => {
    registerLocale('install-question-reordered', {
      'extensionsPanels.capabilityReview.installTitle': 'v{version} de {id} installer?',
    } as Catalogue);
    setLocale('install-question-reordered');

    render(
      <CapabilityReview
        open
        summary={capabilitySummary()}
        onApprove={() => {}}
        onCancel={() => {}}
      />,
    );

    assert.match(document.body.textContent ?? '', /v1\.2\.0 de com\.example\.fire-rating installer\?/);
  });

  it('formats extension dates with the active locale', () => {
    const date = new Date('2026-01-02T13:45:00Z');

    assert.equal(formatExtensionDate(date, 'de-CH', true), date.toLocaleDateString('de-CH'));
    assert.equal(formatExtensionDate(date, 'de-CH'), date.toLocaleString('de-CH'));
  });

  it('uses the active locale for audit and signature timestamps', () => {
    registerLocale('de-CH', {});
    setLocale('de-CH');
    const host = new StubExtensionHost();
    host.audit.append({ kind: 'install', extensionId: 'com.example.audit' });
    const [auditEvent] = host.audit.list();
    const signedAt = '2026-01-02T13:45:00Z';
    const signedSummary: HostInstallSummary = {
      ...capabilitySummary(),
      signed: true,
      signature: {
        algorithm: 'ed25519',
        publicKeyBytes: new Uint8Array(32),
        fingerprint: '00:11:22:33:44:55:66:77:88:99:aa:bb',
        contentHash: 'a'.repeat(64),
        signedAt,
      },
    };

    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <AuditLogPanel />
        <CapabilityReview
          open
          summary={signedSummary}
          onApprove={() => {}}
          onCancel={() => {}}
        />
      </ExtensionHostContext.Provider>,
    );

    assert.match(container.textContent ?? '', new RegExp(formatExtensionDate(auditEvent.ts, 'de-CH').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(document.body.textContent ?? '', new RegExp(formatExtensionDate(signedAt, 'de-CH').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('lets locales reorder complete signature metadata', () => {
    registerLocale('signature-reordered', {
      'extensionsPanels.capabilityReview.signedByLabel': '{date} SIGNED {fingerprint}',
    } as Catalogue);
    setLocale('signature-reordered');
    const signedAt = '2026-01-02T13:45:00Z';
    const fingerprint = '00:11:22:33:44:55:66:77:88:99:aa:bb';
    render(
      <CapabilityReview
        open
        summary={{
          ...capabilitySummary(),
          signed: true,
          signature: {
            algorithm: 'ed25519',
            publicKeyBytes: new Uint8Array(32),
            fingerprint,
            contentHash: 'a'.repeat(64),
            signedAt,
          },
        }}
        onApprove={() => {}}
        onCancel={() => {}}
      />,
    );

    assert.match(
      document.body.textContent ?? '',
      new RegExp(`${formatExtensionDate(signedAt, 'signature-reordered')} SIGNED 00:11:22:33:44:55:66:77…`),
    );
    assert.equal(document.body.querySelector('code[title]')?.getAttribute('title'), fingerprint);
  });

  it('lets locales reorder complete audit metadata', () => {
    registerLocale('audit-metadata-reordered', {
      'extensionsPanels.auditLogPanel.metadataVersionDetail': '{detail} THEN v{version} THEN {date}',
    } as Catalogue);
    setLocale('audit-metadata-reordered');
    const host = new StubExtensionHost();
    host.audit.append({
      kind: 'install',
      extensionId: 'com.example.audit',
      version: '1.2.3',
      grantedCapabilities: ['model.read'],
    });
    const [event] = host.audit.list();
    render(
      <ExtensionHostContext.Provider value={host}>
        <AuditLogPanel />
      </ExtensionHostContext.Provider>,
    );

    assert.match(
      document.body.textContent ?? '',
      new RegExp(`1 capability grant THEN v1\\.2\\.3 THEN ${formatExtensionDate(event.ts, 'audit-metadata-reordered')}`),
    );
  });

  it('lets a locale reorder complete repair help and unknown-SDK messages', async () => {
    registerLocale('repair-help-reordered', {
      'extensionsPanels.repairQueuePanel.helpIntro': '{engineRange} INTRO',
      'extensionsPanels.repairQueuePanel.helpActions': '{repair} BEFORE {runCheck}',
      'extensionsPanels.repairQueuePanel.sdkUnknown': '{appVersion} UNKNOWN',
    } as Catalogue);
    setLocale('repair-help-reordered');

    const host = new StubExtensionHost();
    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <RepairQueuePanel sdkVersion="" />
      </ExtensionHostContext.Provider>,
    );
    openAllHelpHints(container);

    const text = document.body.textContent ?? '';
    assert.match(text, /engines\.ifcLiteSdk INTRO/);
    assert.match(text, /Repair BEFORE Run check/);
    assert.match(text, /__APP_VERSION__ UNKNOWN/);
  });

  it('lets a locale reorder complete rich help messages without translating capability codes', async () => {
    registerLocale('extensions-help-reordered', {
      'extensionsPanels.auditLogPanel.helpExport': 'SNAPSHOT VIA {export}',
      'extensionsPanels.ideasPanel.helpCuratedSubject': 'CURATED',
      'extensionsPanels.ideasPanel.helpCurated': 'BUILT TODAY — {subject}',
      'extensionsPanels.ideasPanel.helpRecurringSubject': 'RECURRING',
      'extensionsPanels.ideasPanel.helpRecurring': 'AFTER REPEATED USE — {subject}',
      'extensionsPanels.ideasPanel.helpActions': '{customize} BEFORE {tryIt}',
      'extensionsPanels.promoteToolDialog.noCapabilitiesDetected':
        'ONLY {capability} IS REQUESTED',
    } as Catalogue);
    setLocale('extensions-help-reordered');

    const host = new StubExtensionHost();
    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <div>
          <AuditLogPanel />
          <IdeasPanel />
          <PromoteToolDialog open source="function run(ctx) { return 1; }" onClose={() => {}} />
        </div>
      </ExtensionHostContext.Provider>,
    );
    // Three separate `HelpHint`s here (#5817: Radix's non-modal dismissal
    // closes each one as the next one's trigger is clicked, so no single
    // live-DOM snapshot holds all three's text at once). Unlike
    // `openAllHelpHints`'s per-element token Set (fine for the plain-string
    // checks elsewhere in this file), an interpolated message like
    // "SNAPSHOT VIA {export}" renders its substitution as a nested element,
    // splitting the phrase across sibling text nodes — so this instead
    // concatenates the WHOLE `document.body.textContent` after each open,
    // exactly mirroring what a single popover's snapshot always did.
    const snapshots: string[] = [];
    for (const button of container.querySelectorAll('button')) {
      if (button.getAttribute('aria-label')?.startsWith('Help: ')) {
        act(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
        snapshots.push(document.body.textContent ?? '');
      }
    }
    const text = snapshots.join('\n');
    assert.match(text, /SNAPSHOT VIA Export/);
    assert.match(text, /BUILT TODAY — CURATED/);
    assert.match(text, /AFTER REPEATED USE — RECURRING/);
    assert.match(text, /Customize plan first… BEFORE Try it/);
    assert.match(text, /ONLY model\.read IS REQUESTED/);
  });

  it('localizes the untouched promoted-tool name without overwriting an edit', () => {
    registerLocale('promote-name-a', {
      'extensionsPanels.promoteToolDialog.defaultName': 'MON OUTIL',
    } as Catalogue);
    registerLocale('promote-name-b', {
      'extensionsPanels.promoteToolDialog.defaultName': 'MEIN WERKZEUG',
    } as Catalogue);
    setLocale('promote-name-a');

    const host = new StubExtensionHost();
    render(
      <ExtensionHostContext.Provider value={host}>
        <PromoteToolDialog open source="function run(ctx) { return 1; }" onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );

    const name = document.body.querySelector<HTMLInputElement>('#tool-name');
    assert.ok(name);
    assert.equal(name.value, 'MON OUTIL');

    act(() => setLocale('promote-name-b'));
    assert.equal(name.value, 'MEIN WERKZEUG');

    typeInput(name, 'User-authored name');
    act(() => setLocale('promote-name-a'));
    assert.equal(name.value, 'User-authored name');
  });

  it('shows and accepts the same fixed high-risk confirmation token in every locale', () => {
    registerLocale('fr', {
      'extensionsPanels.capabilityReview.confirmInstruction':
        'Saisissez {phrase} ci-dessous pour confirmer.',
    } as Catalogue);
    setLocale('fr');

    render(
      <CapabilityReview
        open
        summary={capabilitySummary()}
        onApprove={() => {}}
        onCancel={() => {}}
      />,
    );

    assert.match(document.body.textContent ?? '', /Saisissez approve ci-dessous/);
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="approve"]');
    assert.ok(input, 'the translated instruction exposes the exact validation token');
    const install = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Install'),
    );
    assert.ok(install);
    assert.equal(install.disabled, true);

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setter);
    act(() => {
      setter.call(input, 'approve');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(install.disabled, false);
  });
});

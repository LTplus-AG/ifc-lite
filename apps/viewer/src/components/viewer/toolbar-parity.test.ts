/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Toolbar parity drift guard.
 *
 * The viewer ships TWO toolbars — the classic single strip (`MainToolbar`)
 * and the tabbed `RibbonToolbar` — and a user sits behind exactly one of
 * them (`uiSlice.toolbarStyle`, switchable from both). A capability wired
 * into only one is therefore a silent loss for half the users, and nothing
 * else in CI notices: both surfaces typecheck, both render, both pass their
 * own tests. Three such gaps shipped unnoticed before this guard existed —
 * camera rotate-90° was ribbon-only, the desktop zoom cluster was hidden
 * from classic as a side effect, and inline search was classic-only.
 *
 * The oracle: walk each toolbar's component/hook closure (its own tree
 * plus every shared hook and menu body it pulls in), collect the viewer-store
 * symbols and camera commands each one reaches, and diff the two sets. A
 * symbol only one surface can reach is a capability only one surface can
 * offer — unless it is listed below with a reason.
 *
 * What it CANNOT catch: a control that renders but is dead (reaching a
 * symbol proves reachability of state, not of behaviour), a control behind
 * a condition that is never true, a capability that lives in a symbol both
 * surfaces already read for some other reason, layout/discoverability
 * differences, and anything reached through a lib/ function rather than a
 * store symbol. Those still need the flow executed in both toolbars — which
 * is why every fix here was also clicked through in both styles.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useViewerStore } from '@/store/index.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Surface = 'classic' | 'ribbon';

const ROOTS: Record<Surface, string> = {
  classic: 'components/viewer/MainToolbar.tsx',
  ribbon: 'components/viewer/ribbon/RibbonToolbar.tsx',
};

/**
 * Directories the walk does not descend into. `components/ui` is design-system
 * plumbing, `lib`/`store`/`icons` are shared infrastructure rather than command
 * surfaces — including them would drown the diff in symbols neither toolbar
 * chooses to host.
 */
const STOP_PREFIXES = ['components/ui/', 'lib/', 'store/', 'icons/', 'sdk/'];

/**
 * Every entry is a capability ONE toolbar deliberately does not offer.
 * Adding one is a design decision: say why here, or wire the capability
 * into both surfaces instead.
 */
const ALLOWLIST: { surface: Surface; symbol: string; reason: string }[] = [
  {
    surface: 'ribbon',
    symbol: 'ribbonTab',
    reason: 'Tabs are the ribbon\'s own geography; the classic strip has no tabs to select.',
  },
  {
    surface: 'ribbon',
    symbol: 'setRibbonTab',
    reason: 'Same: only the ribbon has a tab to switch, including via the contextual-tab driver.',
  },
  {
    surface: 'ribbon',
    symbol: 'ribbonCollapsed',
    reason: 'Collapse/expand of the command band — the classic strip is a single strip with nothing to collapse.',
  },
  {
    surface: 'ribbon',
    symbol: 'setRibbonCollapsed',
    reason: 'Same as ribbonCollapsed.',
  },
  {
    surface: 'ribbon',
    symbol: 'ribbonContextualTabs',
    reason: '"Follow work" makes the active tab follow the working context; meaningless without tabs.',
  },
  {
    surface: 'ribbon',
    symbol: 'setRibbonContextualTabs',
    reason: 'Same as ribbonContextualTabs.',
  },
  {
    surface: 'ribbon',
    symbol: 'isMobile',
    reason: 'RibbonSwitchNotice suppresses its one-time "the toolbar changed" line on mobile, where neither desktop toolbar renders at all (ViewerLayout picks MobileToolbar).',
  },
  {
    surface: 'ribbon',
    symbol: 'hierarchyMode',
    reason: 'The Elements tab mirrors the hierarchy panel\'s grouping switch as a ribbon shortcut. The capability itself lives in HierarchyPanel, which both toolbar styles show, so classic users are not missing it.',
  },
  {
    surface: 'ribbon',
    symbol: 'setHierarchyMode',
    reason: 'Same shortcut as hierarchyMode.',
  },
  {
    surface: 'ribbon',
    symbol: 'setPanelShownInSidebar',
    reason: 'Used only to reveal the hierarchy panel when that ribbon shortcut is pressed.',
  },
  {
    surface: 'ribbon',
    symbol: 'setLeftPanelCollapsed',
    reason: 'Same: un-collapses the left panel so the hierarchy shortcut has somewhere to land.',
  },
];

function resolveImport(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  // `@/store/index.js` style specifiers resolve to the .ts source here.
  const withoutJs = base.endsWith('.js') ? base.slice(0, -3) : base;
  const candidates = [
    withoutJs + '.tsx',
    withoutJs + '.ts',
    path.join(withoutJs, 'index.tsx'),
    path.join(withoutJs, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isStopped(file: string): boolean {
  const rel = path.relative(SRC, file);
  return STOP_PREFIXES.some((prefix) => rel.startsWith(prefix))
    || rel.endsWith('.test.ts')
    || rel.endsWith('.test.tsx');
}

/** The identifiers an import clause binds (`X`, `{ a, b as c }`, `* as ns`). */
function boundNames(clause: string): string[] {
  const names: string[] = [];
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  const rest = clause.replace(/\{[^}]*\}/g, '');
  const namespace = rest.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace) names.push(namespace[1]);
  for (const part of rest.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/g, '').split(',')) {
    const name = part.trim().replace(/^type\s+/, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * Every component/hook file a toolbar reaches, transitively.
 *
 * An import only counts as reach when the file actually USES what it
 * imported. Without that check, deleting `<CameraCommandMenuItems />`
 * from the classic menu while leaving its import line behind kept the
 * whole camera closure "reachable" and this guard stayed green on a
 * regression it exists to catch (verified: it did). Side-effect imports,
 * dynamic `import()` and re-exports bind nothing, so they always count.
 */
function closure(root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.join(SRC, root)];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const bodyOnly = source.replace(/^\s*import\s[^;]*?from\s*['"][^'"]+['"];?/gm, '');
    const enqueue = (spec: string, clause?: string) => {
      const resolved = resolveImport(spec, file);
      if (!resolved || seen.has(resolved) || isStopped(resolved)) return;
      if (clause !== undefined) {
        const names = boundNames(clause);
        const used = names.length === 0
          || names.some((name) => new RegExp(`\\b${name}\\b`).test(bodyOnly));
        if (!used) return;
      }
      queue.push(resolved);
    };
    const bindingRe = /import\s+([^;'"]*?)\s+from\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = bindingRe.exec(source)) !== null) enqueue(match[2], match[1]);
    const bareRe = /(?:export\s+[^;]*?\s+from\s*|import\s*\(\s*|^\s*import\s*)['"]([^'"]+)['"]/gm;
    while ((match = bareRe.exec(source)) !== null) enqueue(match[1]);
  }
  return seen;
}

const STORE_KEYS = new Set(Object.keys(useViewerStore.getState()));

/**
 * Capabilities a file reaches: viewer-store symbols (`s.x` / `state.x`,
 * validated against the live store so another store's selector — the tour
 * store's `s.status`, say — cannot masquerade as one) and camera commands
 * (`cameraCallbacks.x`, plus the shared command list's own `callbacks.x`
 * dispatch), namespaced so the two can't collide.
 */
function capabilities(files: Iterable<string>): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (symbol: string, file: string) => {
    if (!found.has(symbol)) found.set(symbol, new Set());
    found.get(symbol)!.add(path.relative(SRC, file));
  };
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const storeRe = /\b(?:s|state|store)\.([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = storeRe.exec(source)) !== null) {
      if (STORE_KEYS.has(match[1])) add(match[1], file);
    }
    const cameraRe = /\b(?:cameraCallbacks|callbacks)\.([A-Za-z_$][\w$]*)/g;
    while ((match = cameraRe.exec(source)) !== null) add(`camera:${match[1]}`, file);
  }
  return found;
}

const surfaces = {
  classic: capabilities(closure(ROOTS.classic)),
  ribbon: capabilities(closure(ROOTS.ribbon)),
} satisfies Record<Surface, Map<string, Set<string>>>;

function exclusiveTo(surface: Surface): string[] {
  const other: Surface = surface === 'classic' ? 'ribbon' : 'classic';
  return [...surfaces[surface].keys()].filter((symbol) => !surfaces[other].has(symbol)).sort();
}

function allowed(surface: Surface): Set<string> {
  return new Set(ALLOWLIST.filter((entry) => entry.surface === surface).map((entry) => entry.symbol));
}

function describeSymbol(surface: Surface, symbol: string): string {
  return `${symbol} (only in ${[...(surfaces[surface].get(symbol) ?? [])].join(', ')})`;
}

describe('toolbar parity between the classic strip and the ribbon', () => {
  it('walks a non-trivial closure for both surfaces', () => {
    // Guards the guard: a broken resolver would silently compare two empty
    // sets and pass forever.
    assert.ok(surfaces.classic.size > 50, `classic reached only ${surfaces.classic.size} symbols`);
    assert.ok(surfaces.ribbon.size > 50, `ribbon reached only ${surfaces.ribbon.size} symbols`);
  });

  it('hosts no capability in the classic strip that the ribbon cannot reach', () => {
    const unexplained = exclusiveTo('classic').filter((symbol) => !allowed('classic').has(symbol));
    assert.deepEqual(
      unexplained.map((symbol) => describeSymbol('classic', symbol)),
      [],
      'classic-only capabilities: wire them into the ribbon too, or add an ALLOWLIST entry saying why not',
    );
  });

  it('hosts no capability in the ribbon that the classic strip cannot reach', () => {
    const unexplained = exclusiveTo('ribbon').filter((symbol) => !allowed('ribbon').has(symbol));
    assert.deepEqual(
      unexplained.map((symbol) => describeSymbol('ribbon', symbol)),
      [],
      'ribbon-only capabilities: wire them into the classic strip too, or add an ALLOWLIST entry saying why not',
    );
  });

  it('carries no stale allowlist entry', () => {
    const stale = ALLOWLIST
      .filter((entry) => !exclusiveTo(entry.surface).includes(entry.symbol))
      .map((entry) => `${entry.surface}:${entry.symbol}`);
    assert.deepEqual(stale, [], 'these are no longer one-sided — delete the entry with its reason');
  });

  it('reaches the same camera commands from both surfaces', () => {
    // The camera set is the one this guard was written for, so it is asserted
    // on its own too: an exclusive here can never be right, since both styles
    // render the same shared command list (toolbar/CameraCommands).
    const cameraOf = (surface: Surface) =>
      [...surfaces[surface].keys()].filter((symbol) => symbol.startsWith('camera:')).sort();
    assert.deepEqual(cameraOf('classic'), cameraOf('ribbon'));
    for (const id of ['camera:zoomIn', 'camera:zoomOut', 'camera:rotateLeft', 'camera:rotateRight']) {
      assert.ok(surfaces.classic.has(id), `${id} unreachable from the classic strip`);
    }
  });
});

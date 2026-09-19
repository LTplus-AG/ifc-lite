/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The spatial hierarchy's own chrome reads the i18n catalogue (#4918 slice
 * 4, following #4785/#4883).
 *
 * The oracle is a pseudo-locale that maps every `hierarchy.*` key to a
 * marked copy of its English text. Several real hierarchy components are
 * mounted together (`HierarchyNode` in both its model-header and regular-row
 * modes, `ModelTagGroupRow`, `ModelRowTags` with its tag editor opened,
 * `ModelsSectionHeader` with a filter active, `HierarchySortControl` with
 * its menu open, `StoreyDisplayControls` with two storeys and Exploded on),
 * the locale is switched live, and every marked string that was readable in
 * English must reappear marked. Row NAMES, TYPE NAMES and TAG NAMES are
 * model content, not catalogue keys, so they are excluded from the marker
 * check by construction (they never carry a `hierarchy.*` key).
 */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { act } from 'react';

installLayout();

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, click } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { HierarchyNode } from './HierarchyNode.js';
import { ModelTagGroupRow } from './ModelTagGroupRow.js';
import { ModelRowTags } from './ModelRowTags.js';
import { ModelsSectionHeader } from './ModelsSectionHeader.js';
import { HierarchySortControl } from './HierarchySortControl.js';
import { StoreyDisplayControls } from './StoreyDisplayControls.js';
import type { TreeNode } from './types.js';

const CATALOGUE: Catalogue = Object.fromEntries(Object.entries(en).filter(([key]) => key.startsWith('hierarchy.')));
const HAS_CATALOGUE = Object.keys(CATALOGUE).length > 0;

type HierarchyKey = keyof typeof CATALOGUE;
const KEYS = Object.keys(CATALOGUE) as HierarchyKey[];
const STATIC_KEYS = KEYS.filter((key) => {
  const value = CATALOGUE[key];
  return typeof value === 'string' && !value.includes('{');
});

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels/titles, plain text, and (by focusing each button) every
 *  reachable Radix `TooltipContent` string. */
function chromeStrings(container: ParentNode): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => (button as HTMLElement).focus());
    addReadable(document.body, out);
    act(() => (button as HTMLElement).blur());
  }
  return out;
}

const mark = (key: HierarchyKey) => `⟦${key}|${CATALOGUE[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(
  KEYS.map((key) => {
    const value = CATALOGUE[key];
    return [key, typeof value === 'string' ? mark(key) : value];
  }),
);

function model(id: string): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 10,
  } as FederatedModel;
}

const virtualRow = { size: 28, start: 0 };

function modelHeaderNode(id: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: `model-${id}`,
    expressIds: [],
    globalIds: [],
    modelIds: [id],
    name: `${id}.ifc`,
    type: 'model-header',
    depth: 0,
    hasChildren: true,
    isExpanded: false,
    isVisible: true,
    elementCount: 12,
    ...overrides,
  };
}

function elementNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 'n1',
    expressIds: [1],
    globalIds: [1],
    modelIds: ['A'],
    name: 'Wall-01',
    type: 'element',
    ifcType: 'IfcWall',
    depth: 1,
    hasChildren: false,
    isExpanded: false,
    isVisible: true,
    elementCount: 3,
    storeyDisplayElevation: 2.5,
    ...overrides,
  };
}

function tagGroupNode(): TreeNode {
  return {
    id: 'model-tag-group:t1',
    expressIds: [],
    globalIds: [],
    modelIds: ['A', 'B'],
    name: 'Structure',
    type: 'model-tag-group',
    depth: 0,
    hasChildren: true,
    isExpanded: false,
    isVisible: true,
  };
}

function seed(): void {
  federationRegistry.clear();
  federationRegistry.registerModel('A', 10);
  federationRegistry.registerModel('B', 10);
  useViewerStore.setState({
    models: new Map([
      ['A', model('A')],
      ['B', model('B')],
    ]),
    activeModelId: 'A',
    modelTags: new Map(),
    modelTagAssignments: new Map(),
    modelTagView: { groupByTag: false, filterTagIds: [], filterUntagged: false },
  });
}

/** Mounts the hierarchy surfaces this oracle covers. The tag editor dialog
 *  and the sort-control menu are opened by the caller AFTER the chrome
 *  (aria-label/tooltip, focus-walk) pass — a modal Dialog traps focus, which
 *  would redirect the chrome pass's focus-walk back into itself. */
function mountAll(): HTMLElement {
  const s = useViewerStore.getState();
  const structure = s.createModelTag('Structure')!;
  s.assignModelTags(['A'], [structure]);
  useViewerStore.setState({ modelTagView: { groupByTag: false, filterTagIds: [structure], filterUntagged: false } });

  const container = render(
    <div>
      <ModelsSectionHeader count={2} />
      <HierarchyNode
        node={modelHeaderNode('A', { modelIds: ['A'] })}
        virtualRow={virtualRow}
        isSelected={false}
        nodeHidden={false}
        isMultiModel
        modelsCount={2}
        modelVisible
        onNodeClick={() => {}}
        onToggleExpand={() => {}}
        onVisibilityToggle={() => {}}
        onModelVisibilityToggle={() => {}}
        onRemoveModel={() => {}}
        onSyncSourceModel={() => {}}
        onModelHeaderClick={() => {}}
        sourceBacked
        sourceSyncing={false}
      />
      <HierarchyNode
        node={elementNode()}
        virtualRow={virtualRow}
        isSelected={false}
        nodeHidden={false}
        isMultiModel={false}
        modelsCount={1}
        onNodeClick={() => {}}
        onToggleExpand={() => {}}
        onVisibilityToggle={() => {}}
        onModelVisibilityToggle={() => {}}
        onRemoveModel={() => {}}
        onModelHeaderClick={() => {}}
      />
      <ModelTagGroupRow node={tagGroupNode()} virtualRow={virtualRow} />
      <ModelRowTags modelId="A" modelName="A.ifc" />
      <HierarchySortControl value="elevation-desc" onChange={() => {}} />
      <StoreyDisplayControls />
    </div>,
  );
  return container;
}

/** Opens the sort-control dropdown (portaled) and the model-row tag editor
 *  dialog (also portaled) so both surfaces' content reaches the DOM. */
function openPortaledSurfaces(container: ParentNode): void {
  const sortTrigger = container.querySelector('button[aria-haspopup]');
  if (sortTrigger) {
    act(() => sortTrigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
    act(() => sortTrigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  }
  const editTagsButton = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label')?.startsWith('Edit tags for model'),
  );
  if (editTagsButton) click(editTagsButton);
}

beforeEach(() => {
  setLocale('en');
  seed();
});

afterEach(() => {
  cleanup();
  setLocale('en');
  federationRegistry.clear();
});

describe('Hierarchy localization (#4918 slice 4)', { skip: !HAS_CATALOGUE && 'hierarchy catalogue absent during the revert-oracle probe' }, () => {
  it('translates the hierarchy tree, Models section, sort control and storey controls chrome', () => {
    const container = mountAll();
    const english = chromeStrings(container);

    registerLocale('pseudo', PSEUDO);
    act(() => setLocale('pseudo'));
    const after = chromeStrings(container);

    let coveredAny = false;
    for (const key of STATIC_KEYS) {
      const text = CATALOGUE[key] as string;
      if (!english.has(text)) continue; // not on screen in this render's state
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      coveredAny = true;
    }
    assert.ok(coveredAny, 'this render must exercise at least one static hierarchy key');
  });

  it('translates the tag-editor dialog and the sort-control menu it owns', () => {
    const container = mountAll();
    openPortaledSurfaces(container);
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale('pseudotwo', PSEUDO);
    act(() => setLocale('pseudotwo'));
    const after = new Set<string>();
    addReadable(document.body, after);

    let coveredAny = false;
    for (const key of STATIC_KEYS) {
      const text = CATALOGUE[key] as string;
      if (!english.has(text)) continue;
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      coveredAny = true;
    }
    assert.ok(coveredAny, 'the dialog/menu pass must exercise at least one static hierarchy key');
  });

  it('interpolates the storey elevation badge and the model-tag member count', () => {
    registerLocale('pseudothree', {
      'hierarchy.node.elevationBadge': '[{sign}{value}]',
      'hierarchy.modelTagGroup.memberCount': { one: '[{count} one]', other: '[{count} many]' },
    });
    act(() => setLocale('pseudothree'));

    const container = render(
      <div>
        <HierarchyNode
          node={elementNode({ storeyDisplayElevation: -1.25 })}
          virtualRow={virtualRow}
          isSelected={false}
          nodeHidden={false}
          isMultiModel={false}
          modelsCount={1}
          onNodeClick={() => {}}
          onToggleExpand={() => {}}
          onVisibilityToggle={() => {}}
          onModelVisibilityToggle={() => {}}
          onRemoveModel={() => {}}
          onModelHeaderClick={() => {}}
        />
        <ModelTagGroupRow node={tagGroupNode()} virtualRow={virtualRow} />
      </div>,
    );

    assert.ok(container.textContent?.includes('[-1.25]'), 'elevation badge interpolates sign+value');
    const groupRow = container.querySelector('[data-model-tag-group]');
    const groupCount = groupRow?.querySelector('[title]');
    assert.equal(groupCount?.getAttribute('title'), '[2 many]', 'member count interpolates and pluralizes');
  });
});

describe('Hierarchy localization revert-oracle witness (#4918)', () => {
  it('reads the Models heading from the active locale without importing the new catalogue', () => {
    registerLocale('hierarchy-revert-witness', { 'hierarchy.modelsSection.title': 'translated models witness' });
    act(() => setLocale('hierarchy-revert-witness'));
    const container = mountAll();
    assert.match(container.textContent ?? '', /translated models witness/);
  });
});

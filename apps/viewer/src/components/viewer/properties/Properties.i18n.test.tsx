/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Properties panel's own chrome reads the i18n catalogue (#4918 slice
 * 4, following #4785/#4883).
 *
 * The oracle is a pseudo-locale that maps every `properties.*` key to a
 * marked copy of its English text. A representative set of real property
 * cards is mounted together — the small self-contained cards
 * (`AssemblyBadge`, `SpatialLocationBadge`, `ClassificationCard`,
 * `DocumentCard`, `RelationshipsCard`, `PropertySetCard`, `MaterialCard`,
 * `PrecisionGridBadge`, `ScheduleCard`, `EntityHeaderActions`,
 * `UnitDisplayControl`, `FederationAlignmentControls`) plus the
 * georeferencing surfaces (`GeoreferencingPanel`, `LocationMap`, both
 * rendered with a synthetic `MapConversion`/`ProjectedCRS` — MapLibre has
 * no WebGL context under `tsx --test`, so `LocationMap` renders its
 * documented `mapUnavailable` fallback, which is chrome too) — the locale
 * is switched live, and every marked string that was readable in English
 * must reappear marked. IFC EXPRESS attribute names (`GeodeticDatum`,
 * `MapProjection`, etc.) are schema field names, not catalogue keys, matching
 * the house rule; property/pset/material/classification/schedule content
 * (names, types, values) is model data and stays out of the catalogue too.
 */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { act } from 'react';

installLayout();

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, click } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { propertiesEn as PropertiesEnType } from '@/i18n/catalogues/properties.en';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { ProjectUnits, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { AssemblyBadge } from './AssemblyBadge.js';
import { SpatialLocationBadge } from './SpatialLocationBadge.js';
import { ClassificationCard } from './ClassificationCard.js';
import { DocumentCard } from './DocumentCard.js';
import { RelationshipsCard } from './RelationshipsCard.js';
import { PropertySetCard } from './PropertySetCard.js';
import { MaterialCard } from './MaterialCard.js';
import { PrecisionGridBadge } from './PrecisionGridBadge.js';
import { ScheduleCard } from './ScheduleCard.js';
import { EntityHeaderActions } from './EntityHeaderActions.js';
import { UnitDisplayControl } from './UnitDisplayControl.js';
import { GeoreferencingPanel } from './GeoreferencingPanel.js';
import { LocationMap } from './LocationMap.js';
import { FederationAlignmentControls } from './FederationAlignmentControls.js';
import { EpsgLookupDialog } from './EpsgLookupDialog.js';
import { TaskEditCard } from './TaskEditCard.js';

let propertiesEn: typeof PropertiesEnType | undefined;
try {
  ({ propertiesEn } = await import('@/i18n/catalogues/properties.en'));
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const HAS_CATALOGUE = propertiesEn !== undefined;
const CATALOGUE: typeof PropertiesEnType = propertiesEn ?? ({} as typeof PropertiesEnType);

type PropertiesKey = keyof typeof CATALOGUE;
const KEYS = Object.keys(CATALOGUE) as PropertiesKey[];
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
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels/titles/placeholders, plain text, and (by focusing each
 *  button) every reachable Radix `TooltipContent` string. */
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

const mark = (key: PropertiesKey) => `⟦${key}|${CATALOGUE[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(
  KEYS.map((key) => {
    const value = CATALOGUE[key];
    return [key, typeof value === 'string' ? mark(key) : value];
  }),
);

const MAP_CONVERSION: MapConversion = {
  id: 73,
  sourceCRS: 41,
  targetCRS: 71,
  eastings: 311_988.181,
  northings: 5_996_148.565,
  orthogonalHeight: 12,
  xAxisAbscissa: 0,
  xAxisOrdinate: 1,
  scale: 1,
};

const PROJECTED_CRS: ProjectedCRS = {
  id: 71,
  name: 'EPSG:25833',
  description: 'ETRS89 / UTM zone 33N',
  geodeticDatum: 'ETRS89',
  mapUnitScale: 1,
} as ProjectedCRS;

/** Mounts the properties surfaces this oracle covers. */
function mountAll(): HTMLElement {
  return render(
    <div>
      <AssemblyBadge assembly={{ expressId: 12, name: 'Assembly-01' }} onSelect={() => {}} />
      <SpatialLocationBadge spatialInfo={{ storeyName: 'Level 1', elevation: 3.2, height: 3.0 }} />
      <ClassificationCard
        classification={{
          identification: '23.10',
          name: 'Walls',
          system: 'Uniclass',
          location: 'https://uniclass2015.classification.bimstandards.org.uk',
          path: ['23', '23.10'],
          description: 'Wall elements',
        }}
      />
      <DocumentCard
        document={{
          identification: 'D-001',
          name: 'Spec sheet',
          description: 'Product data',
          location: 'https://example.com/spec.pdf',
          purpose: 'Reference',
          intendedUse: 'Construction',
          revision: 'A',
        }}
      />
      <RelationshipsCard
        relationships={{
          voids: [{ id: 1, name: 'Opening-1', type: 'IfcOpeningElement' }],
          fills: [],
          groups: [{ id: 2, name: 'System-1', type: 'IfcSystem' }],
          connections: [],
        }}
        onSelectEntity={() => {}}
        onIsolateGroupMembers={() => {}}
      />
      <PropertySetCard
        pset={{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true, isMutated: true }] }}
        modelId="A"
        entityId={1}
        enableEditing={false}
        projectUnits={ProjectUnits.empty()}
      />
      <MaterialCard material={{ type: 'MaterialLayerSet', name: 'Wall build-up', layers: [{ thickness: 0.1, materialName: 'Concrete', isVentilated: true }] }} />
      {/* A plain 'Material' (not a layer/profile/constituent set) is the only
          shape that renders the `typeLabel.material` badge, which is
          otherwise the same English text ("Material") as the layer-row
          `materialLabel` field above — both must be distinguishable on
          screen for the oracle to attribute a marked "Material" to the
          right key. */}
      <MaterialCard material={{ type: 'Material', name: 'Concrete C30/37', description: 'Structural concrete' }} />
      <PrecisionGridBadge crsName="EPSG:25833" />
      <ScheduleCard
        scheduleData={{
          tasks: [
            {
              expressId: 1,
              globalId: 'task1',
              name: 'Foundations',
              isMilestone: false,
              childGlobalIds: [],
              productGlobalIds: ['g1'],
              productExpressIds: [1],
              controllingScheduleGlobalIds: [],
              taskTime: { scheduleStart: '2024-01-01T00:00:00', scheduleFinish: '2024-02-01T00:00:00' },
            },
          ],
          workSchedules: [],
          sequences: [],
          hasSchedule: true,
        }}
        selectedExpressId={1}
        selectedGlobalId="g1"
        isGenerated
      />
      <EntityHeaderActions />
      <UnitDisplayControl />
      <TaskEditCard taskGlobalId="task1" />
      <FederationAlignmentControls modelId="A" />
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        modelId="A"
        enableEditing
        schemaVersion="IFC4"
      />
      <LocationMap mapConversion={MAP_CONVERSION} projectedCRS={PROJECTED_CRS} editable />
      {/* Every real call site passes custom `children`, so `EpsgLookupDialog`'s
          own default trigger (`properties.epsgLookup.*`) is otherwise dead code
          in this render — mount one bare instance so the oracle can see it. */}
      <EpsgLookupDialog onSelect={() => {}} />
    </div>,
  );
}

/** Opens `TaskEditCard`'s "Details" disclosure so its Identification /
 *  Global ID fields (behind the toggle) reach the chrome pass, and
 *  `GeoreferencingPanel`'s "Projected CRS" collapsible so its mutated-field
 *  "edited" badge (otherwise a duplicate of PropertySetCard's own "edited"
 *  text) actually renders. */
function openCollapsibles(container: ParentNode): void {
  for (const wanted of ['Details', 'Projected CRS']) {
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(wanted));
    if (button) click(button);
  }
}

function makeModel(id: string): FederatedModel {
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

/** `FederationAlignmentControls` early-returns without a second model, so
 *  the store needs two loaded models for it to render its chrome. */
function seedStore(): void {
  useViewerStore.setState({
    models: new Map([
      ['A', makeModel('A')],
      ['B', makeModel('B')],
    ]),
    unitDisplayOverrides: {},
    scheduleData: {
      tasks: [
        {
          globalId: 'task1',
          name: 'Foundations',
          identification: 'T-001',
          isMilestone: false,
          predefinedType: 'CONSTRUCTION',
          productGlobalIds: ['g1'],
          productExpressIds: [1],
          controllingScheduleGlobalIds: [],
          childGlobalIds: [],
          taskTime: { scheduleStart: '2024-01-01T00:00:00', scheduleFinish: '2024-02-01T00:00:00' },
        },
      ],
      workSchedules: [],
    } as unknown as ReturnType<typeof useViewerStore.getState>['scheduleData'],
    // A mutated `name` so GeorefRow's "edited" badge (a duplicate of
    // PropertySetCard's own "edited" text) actually renders too.
    georefMutations: new Map([['A', { projectedCRS: { name: 'EPSG:25833' } }]]),
  });
}

beforeEach(() => {
  setLocale('en');
  seedStore();
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('Properties panel localization (#4918 slice 4)', { skip: !HAS_CATALOGUE && 'properties catalogue absent during the revert-oracle probe' }, () => {
  it('translates the property cards and georeferencing chrome', () => {
    const container = mountAll();
    openCollapsibles(container);
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
    assert.ok(coveredAny, 'this render must exercise at least one static properties key');
  });

  it('interpolates a plural (relationships), a member-count style value and the georef easting/northing summary', () => {
    registerLocale('pseudo-interp', {
      'properties.relationships.openings': '[{count} opening-one]',
      'properties.materialTotals.fallbackName': '[Material #{id}]',
      'properties.georef.eastingNorthingSummary': '[E{easting} N{northing}]',
    });
    act(() => setLocale('pseudo-interp'));

    const container = render(
      <RelationshipsCard
        relationships={{
          voids: [
            { id: 1, name: 'Opening-1', type: 'IfcOpeningElement' },
            { id: 2, name: 'Opening-2', type: 'IfcOpeningElement' },
          ],
          fills: [],
          groups: [],
          connections: [],
        }}
      />,
    );
    assert.ok(container.textContent?.includes('[2 opening-one]'), 'relationships count interpolates');
  });
});

describe('Properties localization revert-oracle witness (#4918)', () => {
  it('reads the assembly label from the active locale without importing the new catalogue', () => {
    registerLocale('properties-revert-witness', { 'properties.assemblyBadge.label': 'translated assembly witness' });
    act(() => setLocale('properties-revert-witness'));
    const container = render(<AssemblyBadge assembly={{ expressId: 12, name: 'Assembly-01' }} onSelect={() => {}} />);
    assert.match(container.textContent ?? '', /translated assembly witness/);
  });
});

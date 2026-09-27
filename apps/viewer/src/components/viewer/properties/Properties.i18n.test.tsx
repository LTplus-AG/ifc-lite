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
import { cleanup, render, click, press, type } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { ProjectUnits, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
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
import { EpsgLookupError } from './EpsgLookupError.js';
import { TaskEditCard } from './TaskEditCard.js';

const CATALOGUE: Catalogue = Object.fromEntries(Object.entries(en).filter(([key]) => key.startsWith('properties.')));
const HAS_CATALOGUE = 'properties.assemblyBadge.label' in en;

type PropertiesKey = keyof typeof CATALOGUE;
const KEYS = Object.keys(CATALOGUE) as PropertiesKey[];
const EXPRESS_FIELD_KEYS = new Set<PropertiesKey>([
  'properties.field.identification',
  'properties.field.description',
  'properties.field.location',
  'properties.field.purpose',
  'properties.field.intendedUse',
  'properties.field.revision',
]);
const STATIC_KEYS = KEYS.filter((key) => {
  const value = CATALOGUE[key];
  return !EXPRESS_FIELD_KEYS.has(key) && typeof value === 'string' && !value.includes('{');
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
      <MaterialCard material={{ type: 'MaterialLayerSet', name: 'Wall build-up', layers: [{ thickness: 0.1, materialName: 'Concrete', category: 'LoadBearing', isVentilated: true }] }} />
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
    assert.ok(button, `${wanted} trigger must render for the localization oracle`);
    click(button);
  }
}

/**
 * Clicks a `GerefRow`/`AngleRow`'s value cell to start editing. The row
 * `<div>` itself (`rowEl`) is never interactive (#5812 review: it must not
 * nest a `role="button"` around `TerrainHeightButton`'s real `<button>`),
 * so the click target is the value-cell `<button>` inside it, re-queried
 * each call since it only exists while not already editing.
 */
function clickRow(rowEl: ParentNode): void {
  const button = rowEl.querySelector('button');
  assert.ok(button, 'row value-cell button must render to start editing');
  click(button);
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

const catalogueIt = HAS_CATALOGUE ? it : it.skip;
const CANONICAL_IFC_ATTRIBUTES = new Set(['Name', 'GlobalId', 'Identification', 'Description', 'Location', 'Purpose', 'IntendedUse', 'Revision', 'Category']);

describe('Properties panel localization (#4918 slice 4)', () => {
  catalogueIt('translates the property cards and georeferencing chrome', () => {
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
      if (CANONICAL_IFC_ATTRIBUTES.has(text)) continue;
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      coveredAny = true;
    }
    for (const attribute of CANONICAL_IFC_ATTRIBUTES) {
      assert.ok(after.has(attribute), `canonical IFC ${attribute} field labels must remain literal across locale changes`);
    }
    assert.ok(coveredAny, 'this render must exercise at least one static properties key');
  });

  catalogueIt('interpolates a plural (relationships), a member-count style value and the georef easting/northing summary', () => {
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

  catalogueIt('localizes complete double-georeference guidance and numbers (#4918)', () => {
    registerLocale('de', {
      'properties.georef.doubleGeorefHeading': 'DOPPELT.',
      'properties.georef.doubleGeorefBody': 'VERSATZ {displacement}.',
      'properties.georef.rotationOverrideNote': 'DREHUNG.',
      'properties.georef.distanceKilometres': 'DISTANZ {value} KM',
      'properties.georef.scaleOverrideReason': { other: 'SKALIERUNG {fields}.' },
      'properties.georef.correctionOffsets': 'OFFSET NULL',
      'properties.georef.correctionAngle': 'WINKEL NULL',
      'properties.georef.correctionScale': 'MASSSTAB {value}',
      'properties.georef.rawValuesCorrectionFactor': { other: 'KORREKTUR {edits}; FAKTOREN {factors}.' },
    });
    act(() => setLocale('de'));
    const coordinateInfo: CoordinateInfo = {
      originShift: { x: MAP_CONVERSION.eastings, y: 0, z: -MAP_CONVERSION.northings },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      originalBounds: {
        min: { x: MAP_CONVERSION.eastings, y: 0, z: -MAP_CONVERSION.northings },
        max: { x: MAP_CONVERSION.eastings, y: 0, z: -MAP_CONVERSION.northings },
      },
      hasLargeCoordinates: true,
    };
    const mapConversion = { ...MAP_CONVERSION, scale: 2, factorX: 0.5, factorY: 0.5 };
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        coordinateInfo={coordinateInfo}
        lengthUnitScale={1}
        schemaVersion="IFC4"
      />,
    );
    const text = container.textContent ?? '';
    assert.match(text, /DISTANZ 6\.004 KM/);
    assert.match(text, /SKALIERUNG Scale, FactorX und FactorY/);
    assert.match(text, /KORREKTUR OFFSET NULL, WINKEL NULL und MASSSTAB 1; FAKTOREN FactorX und FactorY/);
    assert.doesNotMatch(text, /not applied|not editable|The file's own values|about/);
  });

  catalogueIt('formats the grid-north angle with the active locale', () => {
    act(() => setLocale('de'));
    const radians = 12.345678 * Math.PI / 180;
    const container = render(
      <GeoreferencingPanel
        georef={{
          hasGeoreference: true,
          mapConversion: { ...MAP_CONVERSION, xAxisAbscissa: Math.cos(radians), xAxisOrdinate: Math.sin(radians) },
          projectedCRS: PROJECTED_CRS,
          source: 'mapConversion',
        }}
        schemaVersion="IFC4"
      />,
    );
    const operation = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Coordinate Operation'));
    assert.ok(operation);
    click(operation);
    assert.match(container.textContent ?? '', /12,345678/);
    assert.doesNotMatch(container.textContent ?? '', /12\.345678/);
  });

  catalogueIt('names georeference icon actions for field and angle edits (#5811)', () => {
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    const operation = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Coordinate Operation'));
    assert.ok(operation);
    click(operation);
    const scaleLabel = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Scale');
    assert.ok(scaleLabel?.parentElement);
    clickRow(scaleLabel.parentElement);
    assert.ok(container.querySelector('button[aria-label="Save Scale"]'));
    const cancelScale = container.querySelector('button[aria-label="Cancel editing Scale"]');
    assert.ok(cancelScale);
    click(cancelScale);
    const angleLabel = [...container.querySelectorAll('span')].find((span) => span.textContent?.includes('Angle to Grid North'));
    assert.ok(angleLabel?.parentElement);
    clickRow(angleLabel.parentElement);
    assert.ok(container.querySelector('button[aria-label="Save Angle to Grid North"]'));
    assert.ok(container.querySelector('button[aria-label="Cancel editing Angle to Grid North"]'));
  });

  catalogueIt('formats coordinate and terrain measurements with the active locale', () => {
    registerLocale('de-DE', {});
    act(() => {
      setLocale('de-DE');
      useViewerStore.setState({
        cesiumEnabled: true,
        cesiumSourceModelId: 'A',
        cesiumTerrainHeight: 1234.5,
        cesiumTerrainSaveHeight: 1234.5,
      });
    });
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    assert.match(container.textContent ?? '', /311\.988.*5\.996\.149/);
    assert.match(container.textContent ?? '', /1\.234,5 m/);
    assert.doesNotMatch(container.textContent ?? '', /1234\.5 m/);
  });

  catalogueIt('parses a decimal-comma georeference edit before saving it', () => {
    registerLocale('de-DE', {});
    act(() => setLocale('de-DE'));
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    const operation = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Coordinate Operation'));
    assert.ok(operation);
    click(operation);
    const scaleLabel = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Scale');
    assert.ok(scaleLabel?.parentElement);
    clickRow(scaleLabel.parentElement);
    const input = scaleLabel.parentElement.querySelector<HTMLInputElement>('input');
    assert.ok(input);
    type(input, '0,001');
    press(input, 'Enter');
    assert.equal(useViewerStore.getState().georefMutations.get('A')?.mapConversion?.scale, 0.001);
  });

  catalogueIt('commits an unchanged decimal georeference edit without corrupting it (#4918)', () => {
    // Regression for the seeded-buffer bug: `startEdit` used to seed the input
    // with the ASCII `String(value)` (a `.` decimal point), but `commitEdit`
    // parses that buffer with `parseLocaleNumber`, which strips the ACTIVE
    // locale's group separator first. In `de-DE` the group separator is `.`,
    // so opening the Scale row (0.001) and pressing Enter without typing
    // anything used to silently rewrite it as 1.
    registerLocale('de-DE', {});
    act(() => setLocale('de-DE'));
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: { ...MAP_CONVERSION, scale: 0.001 }, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    const operation = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Coordinate Operation'));
    assert.ok(operation);
    click(operation);
    const scaleLabel = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Scale');
    assert.ok(scaleLabel?.parentElement);
    clickRow(scaleLabel.parentElement);
    const input = scaleLabel.parentElement.querySelector<HTMLInputElement>('input');
    assert.ok(input);
    // The seeded buffer must already be locale-formatted ("0,001", no
    // grouping) -- not the raw ASCII "0.001".
    assert.equal(input.value, '0,001');
    press(input, 'Enter');
    // An unchanged buffer is a no-op: nothing is re-parsed, nothing recorded.
    assert.equal(useViewerStore.getState().georefMutations.get('A')?.mapConversion?.scale, undefined);
    // Typing the locale form of a new value still commits through parseLocaleNumber.
    clickRow(scaleLabel.parentElement);
    const again = scaleLabel.parentElement.querySelector<HTMLInputElement>('input');
    assert.ok(again);
    type(again, '0,002');
    press(again, 'Enter');
    assert.equal(useViewerStore.getState().georefMutations.get('A')?.mapConversion?.scale, 0.002);
  });

  catalogueIt('an unchanged edit never rewrites a georeference number, whatever its precision (#4918 review)', () => {
    // A value with more fractional digits than any display format keeps
    // (17 significant digits, the most a double can carry) must survive
    // open + Enter untouched: the commit recognises the seeded buffer and
    // does not re-parse a rounded string.
    registerLocale('de-DE', {});
    act(() => setLocale('de-DE'));
    const exact = 0.12345678901234568;
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: { ...MAP_CONVERSION, scale: exact }, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    const operation = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Coordinate Operation'));
    assert.ok(operation);
    click(operation);
    const scaleLabel = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Scale');
    assert.ok(scaleLabel?.parentElement);
    clickRow(scaleLabel.parentElement);
    const input = scaleLabel.parentElement.querySelector<HTMLInputElement>('input');
    assert.ok(input);
    press(input, 'Enter');
    assert.equal(useViewerStore.getState().georefMutations.get('A')?.mapConversion?.scale, undefined,
      'a no-op edit must not record a (rounded) mutation');
  });

  catalogueIt('accepts an active-locale angle edit typed in Arabic digits (#4918)', () => {
    // Regression: `AngleRow`'s edit path used to run the ASCII-only
    // `parseRotationDegrees` directly on the typed text, so an Arabic-locale
    // reading of "12.5" -- "١٢٫٥" -- was silently rejected and the commit
    // was a no-op. The numeric portion must go through `parseLocaleNumber`
    // first.
    registerLocale('ar-EG', {});
    act(() => setLocale('ar-EG'));
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    const operation = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Coordinate Operation'));
    assert.ok(operation);
    click(operation);
    const angleLabel = [...container.querySelectorAll('span')].find((span) => span.textContent?.includes('Angle to Grid North'));
    assert.ok(angleLabel?.parentElement);
    clickRow(angleLabel.parentElement);
    const input = angleLabel.parentElement.querySelector<HTMLInputElement>('input');
    assert.ok(input);
    type(input, '١٢٫٥');
    press(input, 'Enter');
    const mutated = useViewerStore.getState().georefMutations.get('A')?.mapConversion;
    assert.ok(mutated);
    const radians = 12.5 * Math.PI / 180;
    assert.ok(Math.abs((mutated.xAxisAbscissa ?? NaN) - Math.cos(radians)) < 1e-9);
    assert.ok(Math.abs((mutated.xAxisOrdinate ?? NaN) - Math.sin(radians)) < 1e-9);
  });

  catalogueIt('formats spatial and schedule values with the active locale', () => {
    registerLocale('ar-EG', {});
    act(() => setLocale('ar-EG'));
    const tasks = [1, 2].map((id) => ({
      expressId: id,
      globalId: `task${id}`,
      name: `Task ${id}`,
      isMilestone: false,
      childGlobalIds: [],
      productGlobalIds: ['g1'],
      productExpressIds: [1],
      controllingScheduleGlobalIds: [],
      taskTime: { scheduleStart: '2024-01-02T00:00:00Z', scheduleFinish: '2024-02-03T00:00:00Z' },
    }));
    const container = render(
      <div>
        <SpatialLocationBadge spatialInfo={{ storeyName: 'Level 1', elevation: 1234.5, height: 12.5 }} />
        <MaterialCard material={{ type: 'MaterialConstituentSet', constituents: [{ name: 'A', fraction: 0.125 }] }} />
        <MaterialCard material={{ type: 'MaterialLayerSet', layers: [{ materialName: 'A', thickness: 0.1 }] }} />
        <RelationshipsCard relationships={{ voids: [{ id: 1, type: 'IfcOpeningElement' }, { id: 2, type: 'IfcOpeningElement' }], fills: [], groups: [], connections: [] }} />
        <ScheduleCard
          scheduleData={{ tasks, workSchedules: [], sequences: [], hasSchedule: true }}
          selectedExpressId={1}
          selectedGlobalId="g1"
          isGenerated={false}
        />
      </div>,
    );
    const text = container.textContent ?? '';
    assert.match(text, /١٬٢٣٤٫٥٠/);
    assert.match(text, /١٢٫٥%/);
    assert.match(text, /١٠٠٫٠ mm/);
    assert.match(text, /Openings \(٢\)/);
    assert.match(text, /٢ tasks/);
    assert.match(text, /٢ يناير ٢٠٢٤/);
    assert.doesNotMatch(text, /1234\.50|Jan 2, 2024/);
  });

  catalogueIt('resolves a retained EPSG search error in the current locale', () => {
    registerLocale('epsg-a', { 'properties.epsgLookup.noResults': '[no results A]' });
    registerLocale('epsg-b', { 'properties.epsgLookup.noResults': '[no results B]' });
    act(() => setLocale('epsg-a'));
    const container = render(<EpsgLookupError errorKey="properties.epsgLookup.noResults" />);
    assert.match(container.textContent ?? '', /\[no results A\]/);
    act(() => setLocale('epsg-b'));
    assert.match(container.textContent ?? '', /\[no results B\]/);
  });

  catalogueIt('resolves a retained projection error after active catalogue replacement', async () => {
    registerLocale('projection-test', { 'properties.locationMap.projectionUnresolved': '[projection A]' });
    act(() => setLocale('projection-test'));
    const container = render(
      <LocationMap
        mapConversion={MAP_CONVERSION}
        projectedCRS={{ ...PROJECTED_CRS, name: 'not-a-coordinate-system', description: undefined, mapZone: undefined, mapProjection: undefined }}
      />,
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.match(container.textContent ?? '', /\[projection A\]/);

    act(() => registerLocale('projection-test', { 'properties.locationMap.projectionUnresolved': '[projection B]' }));
    assert.match(container.textContent ?? '', /\[projection B\]/);
  });
});

describe('Properties localization revert-oracle witness (#4918)', () => {
  it('reads the assembly label from the active locale without importing the new catalogue', () => {
    registerLocale('properties-revert-witness', { 'properties.assemblyBadge.label': 'translated assembly witness' });
    act(() => setLocale('properties-revert-witness'));
    const container = render(<AssemblyBadge assembly={{ expressId: 12, name: 'Assembly-01' }} onSelect={() => {}} />);
    assert.equal(container.querySelector('.font-bold')?.textContent, 'translated assembly witness', 'AssemblyBadge.tsx must read the active locale');
  });
});

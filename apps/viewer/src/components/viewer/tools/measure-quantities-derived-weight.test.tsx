/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #2736's acceptance at the READOUT, not at the pure function.
 *
 * `measure-modes/weight.test.ts` pins the arithmetic and the refusals.
 * This file pins the two things only the rendered panel can answer:
 *
 * 1. a model with no declared weight but with geometry and a material density
 *    actually PUTS a mass on screen, and
 * 2. the number never appears without the label that says it was derived —
 *    the failure mode the issue is really about is a confident-looking figure
 *    with no provenance, and a pure function cannot fail that way.
 *
 * The store is assembled from STEP lines the way
 * `packages/parser/test/on-demand-material-properties.test.ts` does, so the
 * material-density read goes through the real `extractMaterialPropertiesOnDemand`
 * rather than a stub of it. If that extractor stops resolving
 * `Pset_MaterialCommon`, these tests fail — which is the point.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store/index.js';
import { ToolOverlays } from '../ToolOverlays.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderNode(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TooltipProvider>{node}</TooltipProvider>);
  });
  mounted.push({ root, container });
  return container;
}

const render = (): HTMLElement => renderNode(<ToolOverlays />);

function openSection(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  assert.ok(button, `no section button labelled "${label}" on the measure panel`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

/**
 * A store with one element carrying one material whose `Pset_MaterialCommon`
 * declares a `MassDensity`, built the way the parser's own tests build one.
 */
function densityStore(
  density: number | null,
  declaredWeight?: number,
  unitLines: string[] = [],
) {
  const lines = [`#1=IFCWALL('g1',$,'Wall',$,$,$,$,$,$);`, ...unitLines];
  if (density !== null) {
    lines.push(
      `#10=IFCMATERIAL('Concrete C30/37',$,'concrete');`,
      `#20=IFCPROPERTYSINGLEVALUE('MassDensity',$,${density.toFixed(1)},$);`,
      `#30=IFCMATERIALPROPERTIES('Pset_MaterialCommon',$,(#20),#10);`,
    );
  }
  if (declaredWeight !== undefined) {
    lines.push(
      `#51=IFCQUANTITYWEIGHT('NetWeight',$,$,${declaredWeight.toFixed(1)},$);`,
      `#50=IFCELEMENTQUANTITY('q1',$,'Qto_WallBaseQuantities',$,$,(#51));`,
    );
  }
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, unknown>();
  const byType = new Map<string, number[]>();
  let cursor = 0;
  for (const line of lines) {
    const start = text.indexOf(line, cursor);
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const type = match[2];
      byId.set(expressId, { expressId, type, byteOffset: start, byteLength: line.length, lineNumber: 1 });
      const key = type.toUpperCase();
      const list = byType.get(key) ?? [];
      list.push(expressId);
      byType.set(key, list);
    }
    cursor = start + line.length;
  }

  return {
    source,
    entityIndex: { byId, byType },
    onDemandMaterialMap: density === null
      ? new Map<number, number[]>()
      : new Map<number, number[]>([[1, [10]]]),
    // Present but possibly empty: `extractQuantitiesOnDemand` falls back to the
    // prebuilt quantity TABLE when this map is absent, and these stores have
    // no such table.
    onDemandQuantityMap: declaredWeight === undefined
      ? new Map<number, number[]>()
      : new Map<number, number[]>([[1, [50]]]),
  } as never;
}

/** 0.25 m³ x 2400 kg/m³ = 600 kg — chosen so the rendered figure has no
 *  thousands separator to make the assertion locale-dependent. */
const VOLUME = 0.25;
const DENSITY = 2400;
const EXPECTED_MASS = '600';

function federatedModel(over: Record<string, unknown>) {
  return {
    id: 'm1',
    name: 'model',
    ifcDataStore: densityStore(DENSITY),
    geometryResult: { meshes: [{ expressId: 1, geometryVolume: VOLUME }] },
    visible: true,
    idOffset: 0,
    maxExpressId: 100000,
    loadedAt: 1,
    ...over,
  } as never;
}

beforeEach(() => {
  unmountAll();
  useViewerStore.setState({
    activeTool: 'measure',
    measurements: [],
    activeMeasurement: null,
    pendingMeasurePoint: null,
    measureReferencePoint: null,
    selectedEntity: null,
    selectedEntitiesSet: new Set<string>(),
    models: new Map(),
    ifcDataStore: null,
    geometryResult: null,
    unitDisplayOverrides: {},
  });
});

after(() => {
  unmountAll();
});

describe('#2736 acceptance 1: geometry + density with no declared weight produces a labelled mass', () => {
  it('renders the derived mass', () => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({})]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(
      text,
      new RegExp(`Mass derived\\s*${EXPECTED_MASS} kg`),
      `no derived mass on the panel despite geometry volume and a declared density: ${text}`,
    );
  });

  it('never shows the derived number without the word that says it was derived', () => {
    // The defect #2736 exists to prevent: a confident figure with no
    // provenance. Asserted as "if the number is on screen at all, the label
    // is too", so it holds however the row is later restyled.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({})]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, new RegExp(`${EXPECTED_MASS} kg`), text);
    assert.match(text, /Mass derived/, `the mass rendered without its basis label: ${text}`);
    assert.match(
      text,
      /Not an IFC-declared weight quantity/,
      `the panel showed a calculated mass without saying the file never declared it: ${text}`,
    );
  });

  it('does not label it a declared weight', () => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({})]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.doesNotMatch(
      text,
      /Weight\s*600/,
      `a derived mass was presented as a declared Weight quantity: ${text}`,
    );
  });
});

describe('#2736 acceptance 2: an untrusted volume produces NO mass', () => {
  it('withholds the mass entirely for a federation-rescaled model', () => {
    // Same element, same density, same proved volume — the ONLY difference is
    // that alignment re-baked this model's vertices (#1993), so the volume no
    // longer describes what is on screen. A wrong mass is worse than none.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({ federationAlignmentStatus: 'same-crs' })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.doesNotMatch(
      text,
      /Mass derived/,
      `a rescaled model's invalidated volume became a confident mass: ${text}`,
    );
    assert.doesNotMatch(text, new RegExp(`${EXPECTED_MASS} kg`), text);
  });

  it('says why, rather than looking like a model with no materials', () => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({ federationAlignmentStatus: 'same-crs' })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    assert.match(
      container.textContent ?? '',
      /federation alignment rescaled/,
      container.textContent ?? '',
    );
  });
});

describe('#2736: an element with geometry but no material density gets no mass', () => {
  it('shows the volume and no mass at all', () => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({ ifcDataStore: densityStore(null) })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Volume mesh/, `the proved volume itself went missing: ${text}`);
    assert.doesNotMatch(text, /Mass derived/, `a mass appeared with no density to derive it from: ${text}`);
  });
});

describe('#2736: a server-parsed store has no material psets to read', () => {
  it('reports the proved volume and no mass, without walking an index it does not have', () => {
    // A server-parsed store carries prebuilt property and quantity TABLES and
    // no STEP source — material psets live in `IfcMaterialProperties` entities
    // that only the source can answer for. Asking anyway reads
    // `entityIndex.byId` off a store that has no `entityIndex` and takes the
    // whole panel down with it, which is how this guard was found.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({
        ifcDataStore: {
          source: new Uint8Array(0),
          quantities: { getForEntity: () => [] },
        } as never,
      })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Volume mesh/, `the panel failed to render at all: ${text}`);
    assert.doesNotMatch(text, /Mass derived/, text);
  });
});

/**
 * `MASSDENSITYUNIT` declared as g/m³ rather than kg/m³ (an `IfcDerivedUnit` of
 * gram^1 · metre^-3, so `siScale` is 1e-3). The assignment lists ONLY the
 * derived unit, so `MASSUNIT` stays at its kg default and the rendered symbol
 * is unchanged — the sole difference from the kg/m³ fixtures above is the
 * factor the density has to be converted by.
 *
 * Without this, every component fixture declares its density in the SI unit
 * where the converter's scale is 1, so `densitySiConverterFor` could be the
 * identity function without any test noticing.
 */
const G_PER_M3_UNITS = [
  `#200=IFCSIUNIT(*,.MASSUNIT.,$,.GRAM.);`,
  `#201=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`,
  `#202=IFCDERIVEDUNITELEMENT(#200,1);`,
  `#203=IFCDERIVEDUNITELEMENT(#201,-3);`,
  `#204=IFCDERIVEDUNIT((#202,#203),.MASSDENSITYUNIT.,$);`,
  `#210=IFCUNITASSIGNMENT((#204));`,
  `#220=IFCPROJECT('p1',$,'P',$,$,$,$,$,#210);`,
];

/** A file writing a FORCE unit under `MASSUNIT` — the self-contradiction
 *  #2736 §4 refuses to guess about. Same wall, same density, same volume. */
const FORCE_MASSUNIT_UNITS = [
  `#200=IFCSIUNIT(*,.MASSUNIT.,$,.NEWTON.);`,
  `#210=IFCUNITASSIGNMENT((#200));`,
  `#220=IFCPROJECT('p1',$,'P',$,$,$,$,$,#210);`,
];

describe('#2736: the density is converted from the unit the FILE declared it in', () => {
  it('converts a g/m\u00b3 density before multiplying, rather than reading it as kg/m\u00b3', () => {
    // 2 400 000 g/m³ IS 2400 kg/m³, so the honest answer is the same 600 kg
    // the kg/m³ fixtures report. Taking the number at face value would print
    // 600 000 kg — a thousand-fold error that looks entirely plausible.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({
        ifcDataStore: densityStore(DENSITY * 1000, undefined, G_PER_M3_UNITS),
      })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(
      text,
      new RegExp(`Mass derived\\s*${EXPECTED_MASS} kg`),
      `the file's MASSDENSITYUNIT was not honoured when converting its density: ${text}`,
    );
    assert.doesNotMatch(
      text,
      /600[\s,'\u00a0\u202f]?000/,
      `the g/m\u00b3 density was multiplied in as if it were kg/m\u00b3: ${text}`,
    );
  });
});

describe('#2736 \u00a74: a MASSUNIT that resolves to a force derives nothing', () => {
  it('withholds the mass and says why, instead of guessing kilograms', () => {
    // Everything a derivation needs is present; the only thing wrong is that
    // the file declared newtons under MASSUNIT. kg/m³ x m³ is a mass and this
    // file's own convention says the column is a force, so there is no answer
    // that is not a guess.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({
        ifcDataStore: densityStore(DENSITY, undefined, FORCE_MASSUNIT_UNITS),
      })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.doesNotMatch(
      text,
      /Mass derived/,
      `a mass was derived for a file whose MASSUNIT declares a force: ${text}`,
    );
    assert.doesNotMatch(text, new RegExp(`${EXPECTED_MASS} `), text);
    assert.match(
      text,
      /MASSUNIT declares a force/,
      `the panel withheld the mass without saying why: ${text}`,
    );
    // The volume itself is untouched by the unit confusion — this is a
    // refusal to derive, not a refusal to report what the kernel proved.
    assert.match(text, /Volume mesh/, text);
  });
});

describe('#2736 both directions: a declared weight is still reported, and not derived over', () => {
  it('reports the file\'s own Qto weight and does NOT add a derived mass beside it', () => {
    // Everything a derivation needs is present — proved volume AND a declared
    // density — so an implementation that always derives would show 600 kg
    // here. The file said 1234, and that is the answer.
    useViewerStore.setState({
      selectedEntitiesSet: new Set(['m1:1']),
      models: new Map([['m1', federatedModel({ ifcDataStore: densityStore(DENSITY, 1234) })]]),
    });
    const container = render();
    openSection(container, 'Qty');
    const text = container.textContent ?? '';
    assert.match(text, /Weight net/, `the declared Qto weight stopped being reported: ${text}`);
    assert.doesNotMatch(
      text,
      /Mass derived/,
      `a derivation was shown for an element whose file declares its weight: ${text}`,
    );
    assert.doesNotMatch(
      text,
      new RegExp(`${EXPECTED_MASS} kg`),
      `the declared weight was overwritten by the derived mass: ${text}`,
    );
  });
});

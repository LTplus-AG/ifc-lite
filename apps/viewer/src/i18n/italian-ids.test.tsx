/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { createTranslationService, parseIDS, validateIDS } from '@ifc-lite/ids';
import { IfcParser } from '@ifc-lite/parser';
import { SpecificationCard } from '@/components/viewer/IDSSpecificationCard';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { useViewerStore } from '@/store';
import { installLayout } from '@/test/dom-layout.js';
import { cleanup, click, render } from '@/test/render.js';
import it from './locales/it';
import { activateStartupLocale, createLocaleActivator } from './locale-activation';
import { registerEnglish, setLocale } from './registry';

test('Italian startup synchronizes IDS descriptions and later English switching', async () => {
  const html = { lang: 'en' };
  const activator = createLocaleActivator({ it: async () => it }, html);
  try {
    await activateStartupLocale(activator, { search: '?lang=it', languages: [], storage: null });
    const service = () => createTranslationService(useViewerStore.getState().idsLocale);
    assert.equal(service().t('status.fail'), 'NON CONFORME');
    assert.match(service().describeFacet({ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }, 'requirement'), /IFCWALL/);
    // Lazy registration must not reset an explicit IDS locale choice.
    useViewerStore.getState().setIdsLocale('de');
    registerEnglish({});
    assert.equal(service().locale, 'de');
    await activator.activate(['en']);
    assert.equal(service().t('status.fail'), 'FAIL');
  } finally { setLocale('en'); }
});

test('IT-S2-ASTRA-002: mounted IDS findings show Italian requirements and failures, then English', async () => {
  const initial = useViewerStore.getState();
  const activator = createLocaleActivator({ it: async () => it });
  // Inline parsed data keeps this regression independent of downloaded models.
  const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('ids-locale.ifc','2026-11-05T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'IDS locale fixture',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#10=IFCWALL('0000000000000000000010',$,'Wall A-01',$,$,$,$,$,$);
#11=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F30'),$);
#12=IFCPROPERTYSET('0000000000000000000012',$,'Pset_WallCommon',$,(#11));
#13=IFCRELDEFINESBYPROPERTIES('0000000000000000000013',$,$,$,(#10),#12);
ENDSEC;
END-ISO-10303-21;`;
  const document = parseIDS(`<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>FireRating locale fixture</title></info>
  <specifications>
    <specification name="Wall fire rating" ifcVersion="IFC4">
      <applicability minOccurs="1" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property cardinality="required" dataType="IFCLABEL">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
          <value><simpleValue>F90</simpleValue></value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`);

  function Findings() {
    const report = useViewerStore((state) => state.idsValidationReport);
    if (!report) return null;
    return <SpecificationCard result={report.specificationResults[0]} isIDS
      isActive={false} onSelect={() => {}} onEntityClick={() => {}}
      onIsolateSet={() => {}} filterMode="all" />;
  }

  const restoreLayout = installLayout();
  try {
    const bytes = new TextEncoder().encode(step);
    const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
    const accessor = createDataAccessor(store, 'ids-locale-model');
    // As in useIDS, descriptions are produced at validation time using the
    // synchronized IDS locale; switching language requires a fresh report.
    const validate = () => validateIDS(document, accessor, {
      modelId: 'ids-locale-model', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
    }, { translator: createTranslationService(useViewerStore.getState().idsLocale) });
    await activateStartupLocale(activator, { search: '?lang=it', languages: [], storage: null });
    const italianReport = await validate();
    const result = italianReport.specificationResults[0];
    assert.equal(result.status, 'fail');
    assert.equal(result.applicableCount, 1, 'the real IFCWALL must be checked');
    assert.equal(result.failedCount, 1);
    assert.equal(result.entityResults[0].expressId, 10);
    useViewerStore.setState({ idsValidationReport: italianReport });

    const ui = render(<Findings />);
    assert.match(ui.textContent ?? '', /1 non superato/);
    assert.ok(ui.querySelector('[role="status"][aria-label="Non superato"]'));
    const specification = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Wall fire rating'));
    assert.ok(specification);
    click(specification);
    const italianRequirement = 'La proprietà "Pset_WallCommon.FireRating" deve essere uguale a "F90"';
    const requirement = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes(italianRequirement));
    assert.ok(requirement, 'the mounted requirement must contain Italian prose, not just IFC identifiers');
    click(requirement);
    assert.ok(ui.textContent?.includes('La proprietà "Pset_WallCommon.FireRating" è "F30", atteso "F90"'));
    for (const value of ['Wall A-01', '0000000000000000000010', 'IfcWall']) {
      assert.ok(ui.textContent?.includes(value), `Italian findings preserve model value ${value}`);
    }
    assert.doesNotMatch(ui.textContent ?? '', /Property "Pset_WallCommon.FireRating"/);

    await act(async () => { await activator.activate(['en']); });
    assert.match(ui.textContent ?? '', /1 failed/);
    assert.ok(ui.querySelector('[role="status"][aria-label="Failed"]'));
    const englishReport = await validate();
    act(() => useViewerStore.setState({ idsValidationReport: englishReport }));
    // The same mounted card and expanded requirement receive the new report.
    assert.ok(ui.textContent?.includes('Property "Pset_WallCommon.FireRating" must equal "F90"'));
    assert.ok(ui.textContent?.includes('Property "Pset_WallCommon.FireRating" is "F30", expected "F90"'));
    assert.doesNotMatch(ui.textContent ?? '', /La proprietà|non superato/);
    for (const value of ['Wall A-01', '0000000000000000000010', 'IfcWall']) {
      assert.ok(ui.textContent?.includes(value), `English findings preserve model value ${value}`);
    }
  } finally {
    cleanup();
    restoreLayout();
    setLocale('en');
    useViewerStore.setState({ idsLocale: initial.idsLocale, idsValidationReport: initial.idsValidationReport });
  }
});

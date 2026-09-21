/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import type { IDSAuditReport, IDSDocument } from '@ifc-lite/ids';
import { IDSPanel } from './IDSPanel.js';

const initial = useViewerStore.getState();

const documentFixture: IDSDocument = {
  info: { title: 'Translated pset IDS', version: '1.0' },
  specifications: [{
    id: 'spec-a',
    name: 'Space requirements',
    ifcVersions: ['IFC4'],
    applicability: { facets: [] },
    requirements: [],
  }],
};

// The class of audit result a real-world IDS with translated property names
// produces (#5123): the strict parser accepts the document, the IFC-schema
// cross-check flags every non-standard property inside a standard Pset_*.
const auditWithSchemaErrors: IDSAuditReport = {
  status: 'error',
  parsedDocument: documentFixture,
  issues: [{
    severity: 'error',
    code: 'E_IFC_PROP_NOT_IN_PSET',
    message: 'property "Aussenraum" is not part of Pset_SpaceCommon (IFC4)',
    path: 'specifications[0].requirements[0].baseName',
    facetType: 'property',
  }, {
    severity: 'error',
    code: 'W_IFC_DATATYPE_MISMATCH',
    message: 'Pset_SpaceCommon.IsExternal is typed IFCBOOLEAN in the standard, not IFCTEXT',
    path: 'specifications[0].requirements[1].dataType',
    facetType: 'property',
  }, {
    severity: 'warning',
    code: 'W_REGEX_UNVERIFIED',
    message: 'pattern could not be verified',
    path: 'specifications[0].requirements[2]',
  }],
};

function runButton(ui: HTMLElement): HTMLButtonElement {
  const button = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Run Validation'));
  assert.ok(button, 'Run Validation button rendered');
  return button as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({
    ...initial,
    idsDocument: null,
    idsValidationReport: null,
    idsAuditReport: null,
    idsAuditing: false,
    idsError: null,
    idsLoading: false,
    idsProgress: null,
  });
});

describe('IDSPanel audit gate (#5123)', () => {
  it('lets a parsed document with IFC-schema audit errors run validation anyway', () => {
    useViewerStore.setState({
      idsDocument: documentFixture,
      idsValidationReport: null,
      idsAuditReport: auditWithSchemaErrors,
      idsAuditing: false,
      idsError: null,
      idsLoading: false,
      idsProgress: null,
    });
    const ui = render(<IDSPanel />);
    const button = runButton(ui);
    assert.equal(button.disabled, false, 'audit errors must not block validation');
    // The issues stay listed next to the button …
    assert.match(ui.textContent ?? '', /2 errors/);
    // … together with the hint that the check runs regardless (count = errors only, not warnings).
    assert.match(ui.textContent ?? '', /The audit found 2 errors\. Validation runs anyway/);

    // Clicking reaches runValidation: with no model loaded it reports the
    // missing model, which a disabled button could never have produced.
    click(button);
    assert.deepEqual(useViewerStore.getState().idsError, { labelKey: 'idsPanel.error.noModelLoaded' });
  });

  it('shows no run-anyway hint when the audit only raised warnings', () => {
    useViewerStore.setState({
      idsDocument: documentFixture,
      idsValidationReport: null,
      idsAuditReport: {
        status: 'warning',
        parsedDocument: documentFixture,
        issues: auditWithSchemaErrors.issues.filter((issue) => issue.severity !== 'error'),
      },
      idsAuditing: false,
      idsError: null,
      idsLoading: false,
      idsProgress: null,
    });
    const ui = render(<IDSPanel />);
    assert.equal(runButton(ui).disabled, false);
    assert.doesNotMatch(ui.textContent ?? '', /Validation runs anyway/);
  });

  it('still refuses to validate when the strict parser rejected the document', () => {
    useViewerStore.setState({
      idsDocument: null,
      idsValidationReport: null,
      idsAuditReport: {
        status: 'error',
        issues: [{
          severity: 'error',
          code: 'E_PARSE_XML',
          message: 'unexpected token at line 3 column 7',
          path: '',
          line: 3,
          column: 7,
        }],
      },
      idsAuditing: false,
      idsError: null,
      idsLoading: false,
      idsProgress: null,
    });
    const ui = render(<IDSPanel />);
    assert.equal([...ui.querySelectorAll('button')].some((b) => b.textContent?.includes('Run Validation')), false);
    assert.match(ui.textContent ?? '', /Load Different File/);
  });
});

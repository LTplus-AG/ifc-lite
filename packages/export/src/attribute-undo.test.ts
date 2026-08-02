/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

// Two walls so the second edit can stay pending while the first is undone —
// the exact shape of the #1957 repro (undo with the overlay still dirty).
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('0wall00000000000000001',$,'W-original',$,$,$,$,$,$);
#20=IFCWALL('0wall00000000000000002',$,'W2-original',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parse() {
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(IFC).buffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return { store, view };
}

const exportStep = (store: Awaited<ReturnType<typeof parse>>['store'], view: MutablePropertyView) =>
  decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);

/** The `Name` argument (index 2) of `#id` in exported STEP text. */
function nameOf(step: string, id: number): string | undefined {
  const line = step.split('\n').find(l => l.startsWith(`#${id}=`));
  return line?.slice(line.indexOf('(') + 1, line.lastIndexOf(');')).split(',')[2];
}

/** The `Description` argument (index 3) of `#id` in exported STEP text. */
function descriptionOf(step: string, id: number): string | undefined {
  const line = step.split('\n').find(l => l.startsWith(`#${id}=`));
  return line?.slice(line.indexOf('(') + 1, line.lastIndexOf(');')).split(',')[3];
}

describe('StepExporter — undone attribute edits are not resurrected (#1957)', () => {
  it('exports the reverted value after an UPDATE_ATTRIBUTE is undone', async () => {
    const { store, view } = await parse();

    view.setAttribute(10, 'Name', 'W-edited', 'W-original');
    // A second, unrelated edit: the overlay stays dirty, so the exporter still
    // takes the mutation branch.
    view.setAttribute(20, 'Name', 'W2-edited', 'W2-original');
    // Undo, exactly as mutationSlice does it: replay the inverse with
    // skipHistory, leaving the superseded record in the history.
    view.setAttribute(10, 'Name', 'W-original', undefined, true);

    // The stale record is still in the history — that is the whole point: the
    // exporter must not read it.
    expect(view.getMutations().some(m => m.entityId === 10 && m.newValue === 'W-edited')).toBe(true);

    const out = exportStep(store, view);
    expect(nameOf(out, 10)).toBe("'W-original'");
    expect(nameOf(out, 20)).toBe("'W2-edited'");
  });

  it('exports the base value after a newly-set attribute is undone', async () => {
    const { store, view } = await parse();

    // Description was unset ($), so undo removes the overlay entry outright
    // rather than restoring a prior value.
    view.setAttribute(10, 'Description', 'D-added');
    view.setAttribute(20, 'Name', 'W2-edited', 'W2-original');
    view.removeAttributeMutation(10, 'Description');

    expect(view.getMutations().some(m => m.attributeName === 'Description')).toBe(true);

    const out = exportStep(store, view);
    expect(descriptionOf(out, 10)).toBe('$');
    expect(nameOf(out, 10)).toBe("'W-original'");
    expect(nameOf(out, 20)).toBe("'W2-edited'");
  });

  it('still bakes attribute edits that were never undone', async () => {
    const { store, view } = await parse();

    view.setAttribute(10, 'Name', 'W-edited', 'W-original');
    view.setAttribute(10, 'Description', 'D-added');

    const out = exportStep(store, view);
    expect(nameOf(out, 10)).toBe("'W-edited'");
    expect(descriptionOf(out, 10)).toBe("'D-added'");
  });
});

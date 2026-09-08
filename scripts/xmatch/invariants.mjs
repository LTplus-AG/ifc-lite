/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Does the fixture still REFUSE a corrupt answer key?
 *
 * Three places in the generator can discover that the head revision no longer
 * matches what the key describes. Each of them used to tolerate it quietly —
 * filter the id, skip the chunk, return the list unchanged — and each quiet
 * path ends the same way: a real number, scored to six decimal places, over a
 * model nobody described. Green, precise, and meaningless.
 *
 * They now throw, and this module is the check that they still do. A guard
 * nobody exercises is indistinguishable from a guard that was deleted, which
 * is the same argument as the matcher mutation check one level down: the
 * fixture must be able to fail, and so must the fixture's own integrity code.
 *
 * Pure and fixture-free — no models, no wasm — so it runs in milliseconds as
 * the first thing `--self-test` does.
 */

import { deleteElement, indexModel } from './edits.mjs';
import { resampleableArcs } from './retriangulate.mjs';
import { parseStepFile } from './step-file.mjs';

/** Minimal well-formed STEP text with a `DATA;` section. */
function stepFile(body) {
  return `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${body}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/** Run `probe`, and report unless it threw with a message matching `expect`. */
function mustThrow(name, expect, probe) {
  try {
    probe();
  } catch (error) {
    return expect.test(String(error?.message ?? error))
      ? undefined
      : `${name}: threw, but not about the invariant — ${error?.message}`;
  }
  return `${name}: DID NOT THROW — a corrupt answer key would score as a real result`;
}

/**
 * Exercise every place the generator can detect a broken invariant.
 * Returns a list of failures; empty means all the tripwires still trip.
 */
export function checkInvariantTripwires() {
  const failures = [];

  // 1. An unparsed chunk inside DATA; would silently vanish from the head file.
  failures.push(
    mustThrow('step-file: unparsed chunk', /unparsed chunk in DATA/, () =>
      parseStepFile(stepFile("#1=IFCWALL('a',$);\nthis is not a statement;")),
    ),
  );

  // 1b. A MALFORMED express id must be rejected too, and this is the path the
  //     first version of these tripwires missed entirely — it only covered the
  //     missing-`=` case. `Number.parseInt` is a lexer, not a validator: it
  //     stops at the first character it cannot use and returns what it already
  //     read, so `12A` becomes 12 and `+5` becomes 5. `Number.isInteger` then
  //     sees a perfectly good integer, because the coercion threw the evidence
  //     away before the check ran. A guard whose own tripwire skips it is the
  //     shape this fixture exists to close.
  //     Whitespace is split deliberately: `#1 = IFC...` is legal STEP (space
  //     BETWEEN tokens) and four real fixtures are written that way, while
  //     `# 5` and `1 2` put whitespace INSIDE the name token and are not.
  for (const malformed of ['12A', '+5', '-3', ' 5', '1 2', '0x10', '1e3']) {
    failures.push(
      mustThrow(`step-file: express id '${malformed}'`, /express id/, () =>
        parseStepFile(stepFile(`#${malformed}=IFCWALL('a',$);`)),
      ),
    );
  }

  // ...and `#0`, which IS a run of digits and so passes any syntax rule. It is
  // a RANGE failure, not a syntax one: ISO 10303-21 entity instance names are
  // positive, and id 0 would collide with the falsy-id checks throughout this
  // harness. Kept separate so the message says which of the two is wrong.
  failures.push(
    mustThrow('step-file: express id 0', /express ids start at 1|range/, () =>
      parseStepFile(stepFile("#0=IFCWALL('a',$);")),
    ),
  );

  // Well-formed ids must of course still parse — including the spaced-out
  // `#1 = IFC...` spelling that four fixtures in tests/models actually use. A
  // stricter integer rule is exactly the kind of change that starts rejecting
  // valid files, so the tolerated form is pinned here rather than left to the
  // corpus run to discover.
  for (const [text, expected] of [["#12=IFCWALL('a',$);", 12], ["#12 = IFCWALL('a',$);", 12]]) {
    try {
      const parsed = parseStepFile(stepFile(text));
      if (parsed.statements[0]?.id !== expected) {
        failures.push(`step-file: '${text}' did not parse (got ${parsed.statements[0]?.id})`);
      }
    } catch (error) {
      failures.push(`step-file: '${text}' was rejected — ${error?.message}`);
    }
  }

  // 1c. A DUPLICATE express id is malformed STEP, and tolerating it is the
  //     same corrupted-key failure as the rest: `indexModel` does
  //     `byId.set(statement.id, ...)`, so the second statement silently
  //     overwrites the first, and `permuteIds` keys its map by id, so both
  //     receive the SAME permuted id. The head revision then contains a
  //     collision the answer key does not describe.
  failures.push(
    mustThrow('step-file: duplicate express id', /duplicate express id/, () =>
      parseStepFile(stepFile("#7=IFCWALL('a',$);\n#7=IFCSLAB('b',$);")),
    ),
  );

  // ...but a legal ISO comment is not a chunk, and must still parse.
  try {
    const parsed = parseStepFile(stepFile("/* a comment */\n#1=IFCWALL('a',$);"));
    if (parsed.statements.length !== 1) {
      failures.push(`step-file: a legal ISO comment broke parsing (${parsed.statements.length} statements)`);
    }
  } catch (error) {
    failures.push(`step-file: a legal ISO comment was rejected — ${error?.message}`);
  }

  // 2. Deleting an entity referenced from somewhere other than a top-level
  //    list member would leave a dangling reference behind.
  failures.push(
    mustThrow('edits: dangling reference on delete', /dangling reference/, () => {
      const file = parseStepFile(
        stepFile("#1=IFCWALL('a',$);\n#2=IFCRELAGGREGATES('r',$,$,$,#3,((#1)));\n#3=IFCSITE('s',$);"),
      );
      const index = indexModel(file);
      // #1 is only reachable inside a NESTED list, so it cannot be pruned out.
      deleteElement(file, index, 1);
    }),
  );

  // 3. A curve SHARED with another occurrence must not be offered for
  //    re-sampling: `retriangulateElement` rewrites it in place, so a shared
  //    one would change geometry the answer key calls untouched.
  const shared = (secondOwner) =>
    stepFile(
      [
        "#1=IFCWALL('a',$,$,$,$,#10,#20);",
        '#10=IFCLOCALPLACEMENT($,$);',
        '#20=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));',
        "#21=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#22));",
        '#22=IFCEXTRUDEDAREASOLID(#23,$,$,1.);',
        '#23=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#24);',
        '#24=IFCCOMPOSITECURVE((#25),.F.);',
        '#25=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#26);',
        '#26=IFCTRIMMEDCURVE(#27,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(90.)),.T.,.PARAMETER.);',
        '#27=IFCCIRCLE(#28,1.);',
        '#28=IFCAXIS2PLACEMENT2D(#29,$);',
        '#29=IFCCARTESIANPOINT((0.,0.));',
        // A second occurrence pointing at the SAME trimmed curve.
        ...(secondOwner ? ['#30=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#26);'] : []),
      ].join('\n'),
    );

  const owned = resampleableArcs(indexModel(parseStepFile(shared(false))), 1);
  if (owned.length !== 1) {
    failures.push(`retriangulate: an exclusively owned arc was not offered (${owned.length} found)`);
  }
  const leaked = resampleableArcs(indexModel(parseStepFile(shared(true))), 1);
  if (leaked.length !== 0) {
    failures.push(
      'retriangulate: an arc shared with a second occurrence WAS offered for re-sampling — ' +
        'rewriting it would mutate an element the answer key calls untouched',
    );
  }

  return failures.filter((failure) => failure !== undefined);
}

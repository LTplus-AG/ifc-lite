/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { NAMESPACE_SCHEMAS } from '@ifc-lite/sandbox/schema';
import { buildSystemPrompt } from './system-prompt.js';
import { createPatchDiagnostic } from './script-diagnostics.js';

test('system prompt includes all schema namespaces and methods', () => {
  const prompt = buildSystemPrompt();

  for (const schema of NAMESPACE_SCHEMAS) {
    assert.match(
      prompt,
      new RegExp(`###\\s+bim\\.${schema.name}\\s+—`),
      `Missing namespace heading for bim.${schema.name}`,
    );
    for (const method of schema.methods) {
      assert.match(
        prompt,
        new RegExp(`bim\\.${schema.name}\\.${method.name}\\(`),
        `Missing method reference for bim.${schema.name}.${method.name}()`,
      );
    }
  }
});

test('system prompt includes script editor revision context when provided', () => {
  const prompt = buildSystemPrompt(undefined, undefined, {
    content: 'const n = 1;',
    revision: 42,
    selection: { from: 6, to: 7 },
  });
  assert.match(prompt, /Current script revision:\s+42/);
  assert.match(prompt, /Current selection:\s+from=6, to=7/);
  assert.match(prompt, /```ifc-script-edits/);
  assert.match(prompt, /<<<<<<< SEARCH/);
  assert.match(prompt, /Copy every SEARCH block exactly from the CURRENT script/);
  assert.match(prompt, /Each SEARCH block must match exactly one location/);
  assert.match(prompt, /The system also understands legacy JSON edit ops, but SEARCH\/REPLACE is the default/);
  assert.match(prompt, /For create or explicit rewrite turns, wrap runnable code in a ```js``` fence\. For repair turns, return exactly one ```ifc-script-edits``` fence containing SEARCH\/REPLACE blocks and no ```js``` fence\./);
  assert.match(prompt, /Do NOT answer with a detached snippet/);
});

test('system prompt includes storey hierarchy context when provided', () => {
  const prompt = buildSystemPrompt({
    models: [{ name: 'Tower', entityCount: 500 }],
    typeCounts: { IfcWall: 120 },
    selectedCount: 0,
    storeys: [
      { modelName: 'Tower', name: 'Level 01', elevation: 0, height: 3.5, elementCount: 42 },
      { modelName: 'Tower', name: 'Level 02', elevation: 3.5, height: 3.5, elementCount: 40 },
    ],
  });
  assert.match(prompt, /CURRENT MODEL STATE/);
  assert.match(prompt, /Storeys: Tower: Level 01 @ 0m, height≈3.5m, elements=42 \| Tower: Level 02 @ 3.5m, height≈3.5m, elements=40/);
});

test('system prompt includes selected entity IFC context when provided', () => {
  const prompt = buildSystemPrompt({
    models: [{ name: 'Tower', entityCount: 500 }],
    typeCounts: { IfcWall: 120 },
    selectedCount: 2,
    selectedEntities: [
      {
        modelName: 'Tower',
        name: 'Facade Panel A',
        type: 'IfcCurtainWall',
        selectionKind: 'occurrence',
        storeyName: 'Level 10',
        storeyElevation: 31.5,
        propertySets: ['Pset_CurtainWallCommon'],
        typePropertySets: ['Pset_CurtainWallTypeCommon'],
        quantitySets: ['Qto_CurtainWallBaseQuantities'],
        materialName: 'Aluminium',
        classifications: ['A-123'],
      },
      {
        modelName: 'Tower',
        name: 'Exterior Wall Type',
        type: 'IfcWallType',
        selectionKind: 'type',
        propertySets: ['Pset_WallCommon'],
        classifications: ['A-WALL'],
      },
    ],
  });
  assert.match(prompt, /2 entities currently selected in the viewer/);
  assert.match(prompt, /Selected entities: Tower: IfcCurtainWall "Facade Panel A", kind=occurrence, storey=Level 10@31.5m, psets=Pset_CurtainWallCommon, typePsets=Pset_CurtainWallTypeCommon, qsets=Qto_CurtainWallBaseQuantities, material=Aluminium, classifications=A-123 \| Tower: IfcWallType "Exterior Wall Type", kind=type, psets=Pset_WallCommon, classifications=A-WALL/);
});

test('system prompt includes the BIM.STORE cheat sheet and routing rule', () => {
  const prompt = buildSystemPrompt();

  // Section heading + the three method examples
  assert.match(prompt, /## BIM\.STORE CHEAT SHEET/);
  assert.match(prompt, /bim\.store\.setPositionalAttribute\(profile, 3, 0\.6\)/);
  assert.match(prompt, /bim\.store\.addEntity\("arch"/);
  assert.match(prompt, /bim\.store\.removeEntity\(unwantedRef\)/);

  // Routing rule disambiguating store / mutate / create
  assert.match(prompt, /bim\.store\.setPositionalAttribute\(entity, index, value\)`? for positional STEP-argument edits/);
  assert.match(prompt, /Do NOT use `bim\.create` for these/);
});

test('system prompt includes method-specific create contract guidance', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /BIM\.CREATE CONTRACT CHEAT SHEET/);
  assert.match(prompt, /addIfcRoof.*mono-pitch roof slab.*Do NOT use `Profile`, `Height`, or `ExtrusionHeight`/s);
  assert.match(prompt, /addIfcGableRoof.*dual-pitch house roofs/s);
  assert.match(prompt, /addIfcWallDoor.*wall-local `Position`/s);
  assert.match(prompt, /addIfcWallWindow.*wall-local `Position`/s);
  assert.match(prompt, /Wall-hosted openings: use `Openings` inside `addIfcWall/);
  assert.match(prompt, /resolve the target storeys first and then add geometry to EACH intended storey/);
  assert.match(prompt, /When CURRENT MODEL STATE includes storeys, use those storey names\/elevations as the source of truth/);
  assert.match(prompt, /inspect the actual model first.*bim\.query\.selection\(\).*bim\.query\.storeys\(\).*bim\.query\.path\(entity\).*bim\.query\.materials\(entity\).*bim\.query\.classifications\(entity\)/s);
  assert.match(prompt, /Materials are usually NOT ordinary property-set values/);
  assert.match(prompt, /Prefer `bim\.query\.classifications\(entity\)` over guessing ad-hoc classification properties/);
  assert.match(prompt, /const material = bim\.query\.materials\(wall\);/);
  assert.match(prompt, /Distinguish occurrence vs type edits: occurrence\/entity-specific changes belong on the occurrence; shared defaults and inherited type properties belong on the related `Ifc\.\.\.Type` entity/);
  assert.match(prompt, /If CURRENT MODEL STATE marks a selection as `kind=type`, treat it as a type object and avoid describing it as one physical placed occurrence/);
  assert.match(prompt, /inspect `bim\.query\.typeProperties\(entity\)` before editing inherited values; mutate the type entity when the intent is to change all occurrences that share that type/);
  assert.match(prompt, /IFC export preserves edits to type-owned property sets when you export after applying mutations/);
  assert.match(prompt, /addIfcDoor` and `addIfcWindow`: these create standalone world-aligned elements/);
  assert.match(prompt, /If doors or windows appear rotated 90° relative to a wall/);
  assert.match(prompt, /If repeated elements appear only at one level/);
  assert.match(prompt, /house, pitched-roof, or gable-roof requests, prefer `addIfcGableRoof`/);
  assert.match(prompt, /If the user asks for a house roof, pitched roof, or gable roof, default to `addIfcGableRoof`/);
  assert.match(prompt, /convert it to radians first .*addIfcRoof.*addIfcGableRoof/s);
  assert.match(prompt, /addElement.*Use `IfcType`, `Placement:/s);
  assert.match(prompt, /Use `IfcType` not `Type`; use `Placement` not `Position`/);
  assert.match(prompt, /Many advanced methods are world-placement based/);
  assert.match(prompt, /addIfcPlate.*`Position`, `Width`, `Depth`, `Thickness`/);
  assert.match(prompt, /Mixed multi-level scripts often combine both/);
  assert.match(prompt, /those calls should usually use `elevation`.*`Start`.*`End`.*`Position`/s);
  assert.match(prompt, /const elevation = i \* storeyHeight;/);
  assert.match(prompt, /When a fix targets an existing script, preserve the project handle, storey handles, loop variables/);
  assert.match(prompt, /If a previous repair was rejected for losing context, keep the full script intact/);
  assert.match(prompt, /If repeated world-placement elements stack at the base level/);
});

test('system prompt adapts task focus for repair turns', () => {
  const prompt = buildSystemPrompt(undefined, undefined, {
    content: 'const wall = bim.create.addIfcWall(h, storey, { Start: [0,0,0] });',
    revision: 7,
    selection: { from: 0, to: 0 },
  }, {
    userPrompt: 'fix the revision conflict and keep the current script',
    diagnostics: [
      createPatchDiagnostic(
        'patch_revision_conflict',
        'Edit ops targeted revision 3 but the current editor revision is 4.',
        'error',
        { attemptedOpIds: ['declare-width-depth'] },
      ),
    ],
  });

  assert.match(prompt, /## CURRENT TASK FOCUS/);
  assert.match(prompt, /Primary intent: `repair`/);
  assert.match(prompt, /For repair turns, answer with patch blocks only and do not include a full runnable script fence/);
  assert.match(prompt, /use them as anchors, but fix the stated root cause even if multiple related spans must change/);
  assert.match(prompt, /Root causes:/);
  assert.match(prompt, /\[root-cause:stale_patch_target\]/);
  assert.match(prompt, /\[patch:patch_revision_conflict\] Edit ops targeted revision 3 but the current editor revision is 4/);
});

test('system prompt explains uploaded file runtime access', () => {
  const prompt = buildSystemPrompt(undefined, [
    {
      id: 'entities-1',
      name: 'entities-1.csv',
      type: 'text/csv',
      size: 256,
      textContent: 'GlobalId,Description\nabc,Wall A\n',
      csvColumns: ['GlobalId', 'Description'],
      csvData: [{ GlobalId: 'abc', Description: 'Wall A' }],
    },
  ]);

  assert.match(prompt, /UPLOADED FILES/);
  assert.match(prompt, /bim\.files\.list\(\)/);
  assert.match(prompt, /bim\.files\.csv\(name\)/);
  assert.match(prompt, /Scripts can access the full attachment contents at runtime/);
  assert.match(prompt, /Do not use `fetch\(\)` for chat attachments/);
  assert.match(prompt, /Attachment-driven model edit \(common workflow\)/);
  assert.match(prompt, /bim\.mutate\.setAttribute\(entity, "Description", byGuid\[guid\]\)/);
  assert.match(prompt, /Type-level edit/);
  assert.match(prompt, /const typeProps = bim\.query\.typeProperties\(wall\);/);
  assert.match(prompt, /bim\.mutate\.setProperty\(typeProps\.type, "Pset_WallCommon", "Reference", "EXT"\)/);
  assert.match(prompt, /bim\.export\.ifc\(entities, \{ filename: "updated\.ifc", includeMutations: true \}\)/);
  assert.match(prompt, /Text preview:/);
});

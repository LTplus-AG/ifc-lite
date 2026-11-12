import { inheritedFireRating, typeOf } from '../lib/measured-oracles.mjs';
import { task, downloadCount, nextDownload } from '../lib/driver.mjs';
import { escape, tool, typeFields, oracleModel, openStoreyManager } from '../lib/model-ui.mjs';
import { check, field, wall, selectWall, inspector, typeScope, newType, layer, applyLayers, body, wallSize, layerThicknesses, scheduleLengths, near, finish } from '../lib/authoring-helpers.mjs';

export default {
    id: 'ui.type-editing', capability: 'type-editing',
    title: 'Place two walls of one type, edit its layer thickness',
    async run(s) {
      const tasks = [await task(s, 'create WT-200 and place two instances', async () => {
        await newType(s,'WT-200');
        await wall(s);
        await wall(s,3);
        await selectWall(s);
      })];
      tasks.push(await task(s,'apply 300 mm layers to Type',async () => {
        await field(s,s.page.getByLabel('Layer 1 thickness in metres'),.3);
        await typeScope(s);
        await applyLayers(s);
      }));
      const { step } = await oracleModel(s);
      const sizes = step.of('IFCWALL').map((e) => wallSize(step,e));
      const typed = new Set(step.of('IFCRELDEFINESBYTYPE').flatMap((r) => (r.args[4] ?? []).map((v) => v.ref)));
      tasks.push(await task(s, 'edit inherited FireRating with Apply To Type', async () => {
        await selectWall(s);
        await s.ui.click(s.page.getByRole('button', { name: /^FireRating:/ }));
        await field(s, s.page.getByRole('textbox').last(), 'REI60');
        await s.ui.click(s.page.getByRole('button', { name: 'Apply To Type', exact: true }));
      }));
      const shared = (await oracleModel(s)).step;
      tasks.push(await task(s, 'swap only wall 2 to WT-150', async () => {
        await selectWall(s,3);
        await newType(s,'WT-150');
        await field(s,s.page.getByLabel('Layer 1 thickness in metres'),.15);
        await typeScope(s);
        await applyLayers(s);
      }));
      const swapped = (await oracleModel(s)).step;
      const [w1,w2] = step.of('IFCWALL');
      return finish(s,tasks,[
        check('two typed walls exported', sizes.length === 2 && step.of('IFCWALL').every((w) => typed.has(w.id)), `${sizes.length} walls; ${typed.size} typed occurrences`),
        check('both instances update to 300 mm', sizes.length === 2 && sizes.every((v) => near(v.thickness,.3)), JSON.stringify(sizes)),
        check('FireRating stored once on the shared wall type', inheritedFireRating(shared,shared.of('IFCWALL')), 'Requires one HasPropertySets reference and no occurrence copy'),
        check('only wall 2 swaps type and thickness', !!w1 && !!w2 && typeOf(swapped,w1.id) === typeOf(step,w1.id) && typeOf(swapped,w2.id) !== typeOf(step,w2.id) && near(wallSize(swapped,swapped.get(w2.id)).thickness,.15), JSON.stringify(swapped.of('IFCWALL').map(w => ({id:w.id,type:typeOf(swapped,w.id),...wallSize(swapped,w)})))),
      ]);
    },
  };

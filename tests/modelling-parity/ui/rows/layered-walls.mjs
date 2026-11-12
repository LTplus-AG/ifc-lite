import { task, downloadCount, nextDownload } from '../lib/driver.mjs';
import { escape, tool, typeFields, oracleModel, openStoreyManager } from '../lib/model-ui.mjs';
import { check, field, wall, selectWall, inspector, typeScope, newType, layer, applyLayers, body, wallSize, layerThicknesses, scheduleLengths, near, finish } from '../lib/authoring-helpers.mjs';

export default {
    id: 'ui.layered-walls', capability: 'layered-walls',
    title: 'Create a layered wall type with three named materials',
    async run(s) {
      const tasks = [await task(s, 'wall type WT-230, brick/insulation/plaster layers', async () => {
        await newType(s, 'WT-230');
        await layer(s,1,.115,'Brick');
        await s.ui.click(s.page.getByRole('button', { name: 'Layer', exact: true }));
        await layer(s,2,.1,'Insulation');
        await s.ui.click(s.page.getByRole('button', { name: 'Layer', exact: true }));
        await layer(s,3,.015,'Plaster');
        await typeScope(s);
        await applyLayers(s);
        await wall(s);
      })];
      const { step } = await oracleModel(s);
      const layers = layerThicknesses(step);
      const sizes = step.of('IFCWALL').map((e) => wallSize(step,e));
      return finish(s,tasks,[
        check('ordered 115/100/15 mm layer set exported', layers.some((ls) => ls.length === 3 && ls.every((v,i) => near(v,[.115,.1,.015][i]))), JSON.stringify(layers)),
        check('typed wall thickness follows the 230 mm type', sizes.length === 1 && near(sizes[0].thickness,.23), JSON.stringify(sizes)),
        check('section and retyping update layers', false, 'not yet measured: section layer display and switching to a second layered type'),
      ]);
    },
  };

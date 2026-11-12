import { openFrontSection } from '../lib/probe-helpers.mjs';
import { layerUsage } from '../lib/measured-oracles.mjs';
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
      let polygons = [];
      tasks.push(await task(s, 'section cuts each material layer', async () => {
        const id = step.of('IFCWALL')[0]?.id;
        await openFrontSection(s);
        polygons = await s.state(id => (globalThis.__ifc_lite_viewer_store__.getState().drawing2D?.cutPolygons ?? []).filter(p => p.entityId === id), id);
      }));
      tasks.push(await task(s, 'retype the wall as WT-200-L (150/50 mm)', async () => {
        await selectWall(s);
        await newType(s, 'WT-200-L');
        await layer(s,1,.15,'Core');
        await s.ui.click(s.page.getByRole('button', { name: 'Layer', exact: true }));
        await layer(s,2,.05,'Finish');
        await typeScope(s);
        await applyLayers(s);
      }));
      const retyped = (await oracleModel(s)).step;
      const newWall = retyped.of('IFCWALL')[0];
      return finish(s,tasks,[
        check('ordered 115/100/15 mm layer set exported', layers.some((ls) => ls.length === 3 && ls.every((v,i) => near(v,[.115,.1,.015][i]))), JSON.stringify(layers)),
        check('typed wall thickness follows the 230 mm type', sizes.length === 1 && near(sizes[0].thickness,.23), JSON.stringify(sizes)),
        check('section has three distinct layer fills', polygons.length >= 3 && new Set(polygons.map(p => JSON.stringify(p.fillColor ?? p.fill))).size >= 3, JSON.stringify(polygons)),
        check('retyping changes body and material usage to 150/50 mm', near(wallSize(retyped,newWall).thickness,.2) && layerUsage(retyped,newWall,[.15,.05]), JSON.stringify(wallSize(retyped,newWall))),
      ]);
    },
  };

import { task, downloadCount, nextDownload } from '../lib/driver.mjs';
import { escape, tool, typeFields, oracleModel, openStoreyManager } from '../lib/model-ui.mjs';
import { check, field, wall, selectWall, inspector, typeScope, newType, layer, applyLayers, body, wallSize, layerThicknesses, scheduleLengths, near, finish } from '../lib/authoring-helpers.mjs';

export default {
    id: 'ui.wall-constraints', capability: 'wall-top-base-constraints',
    title: 'Attach a wall to Level 2 and raise the floor-to-floor',
    async run(s) {
      const tasks = [await task(s, 'add Level 2 and draw on Level 1', async () => {
        await openStoreyManager(s);
        await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first());
        await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Level 1' }));
        await s.ui.click(s.page.getByRole('button', { name: 'Back to the inspector' }));
        await wall(s);
        await selectWall(s);
        await s.ui.click(s.page.locator('[data-model-inspector]').getByText('To storey above', { exact: true }));
      })];
      tasks.push(await task(s, 'raise Level 1 to 3.4 m', async () => {
        await openStoreyManager(s);
        await field(s, s.page.getByLabel('Floor-to-floor height of Level 1, metres'), 3.4);
      }));
      const { step } = await oracleModel(s);
      const sizes = step.of('IFCWALL').map((e) => wallSize(step,e));
      return finish(s, tasks, [
        check('wall reaches the moved storey at 3.4 m', sizes.length === 1 && near(sizes[0].height,3.4), JSON.stringify(sizes)),
        check('top/base offsets and slab underside attachment', false, 'wall inspector offers fixed height or storey above; no top/base offset or slab attachment flow exercised'),
      ]);
    },
  };

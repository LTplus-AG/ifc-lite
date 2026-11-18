/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Establish an inherited property through Properties, not a fabricated exported answer. */
export async function addTypeFireRating(s, typeName) {
  const type = s.page.getByRole('button',{name:new RegExp(`${typeName}.*IfcRelDefinesByType`)});
  if (!(await type.isVisible())) await s.ui.click(s.page.getByRole('button',{name:/^Relationships/}));
  if (!(await type.count())) throw new Error('Properties exposes no relationship navigation to the assigned wall type.');
  await s.ui.click(type);
  await s.ui.click(s.page.getByRole('button',{name:'Add property',exact:true}));
  const dialog = s.page.getByRole('dialog');
  await s.ui.click(dialog.getByRole('button',{name:'Custom name',exact:true}));
  for (const [name,value] of [['Property Set','Pset_WallCommon'],['Property','FireRating'],['Value','REI30']]) {
    await s.ui.click(dialog.getByLabel(name,{exact:true}));
    await s.ui.type(value);
  }
  await s.ui.click(dialog.getByRole('button',{name:'Add Property',exact:true}));
  await dialog.waitFor({state:'hidden',timeout:5000});
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8947: loaded as source by the real ExtensionHostService / QuickJS runtime.
// The host source wrapper invokes this named entry after loading the bundle.
// eslint-disable-next-line no-unused-vars
async function run(ctx) {
  const selected = ctx.bim.query.selection();
  if (selected.length === 0) throw new Error('Select a real IFC entity first');
  if (ctx.args.visible === true) ctx.bim.viewer.show(selected);
  else if (ctx.args.visible === false) ctx.bim.viewer.hide(selected);
  else throw new Error('Expected a boolean visible argument');
}

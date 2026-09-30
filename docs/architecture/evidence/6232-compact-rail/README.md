<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Compact Model rail — charter #6232

A fresh canonical browser load of the public ArchiCAD AC20-FZK-Haus model at
1280×800 shows the grouped rail and real model in [the viewport](ac20-800.png).
[The Edit menu](ac20-edit-menu-800.png) retains each command, shortcut and refusal
reason. These are actual screenshots from headless Chromium with software GPU,
not generated UI images. The fixture hash and actual newly built runtime hash
are recorded in [the browser result](browser-result.json).

The rail's available height was 643 px. Its grouped list's client and scroll
heights were both 518 px, and its footer ended at y=772, inside the viewport.
Keyboard ArrowDown reached all 18 canonical tools exactly once through the four
group menus; Escape returned focus to each trigger. The actual Slab command
started, and Select ended it. Increasing the viewport to 1400 px restored the
full direct rail with no overflow. Shrinking it to 640 px kept Leave reachable
and successfully exited the workspace. No page errors occurred.

Five mounted regression tests cover grouping, every command's reachability,
actual command/active state, disabled workplane refusal, keyboard dismissal and
focus, and resizing. The existing 17 rail tests also pass. Root typecheck and
lint passed, and an independent agent reviewed the responsive measurement and
canonical command/refusal paths. This evidence establishes the rail behavior;
it does not establish performance, geometric correctness or the full charter.

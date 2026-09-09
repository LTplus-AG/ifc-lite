# Retain instanced objects across model visibility changes

Issue #4428 was reproduced with two copies of the corpus AC20-FZK-Haus IFC,
without applying any appearance conversion. The second model's mapped
IfcMember 35169 and sibling 35304 initially existed only in GPU instance
buffers. Hiding their model caused a flat geometry reshape to delete those
buffers; showing it could not replay the already drained instance shards.
[The original run](before.json) records both owners absent after hide and show.

With the visibility fix, loaded models retain their instance templates and
model visibility contributes to the renderer's hidden-entity mask. The mask is
derived independently of manual entity hides and isolation. It uses canonical
geometry-bearing entity IDs even when optional geometry hashes are absent,
plus global flat and instance inventories for overlay-created owners.
Removing a model still releases its templates.

[The fixed run](after.json) retains both owners across hide/show. Retention does
not imply visibility: [the hidden member disappears](model-hidden.png), and a
real viewport click at its former location selects nothing. After showing the
model, [a real click selects the restored member](model-shown.png), with its
original IFC GlobalId `0oTQ6V1VbChulreA_hfmUa` and properties.

The corpus IFC SHA-256 is
`ea6f04eaf92fac4d7ad0038bc3d2dfea4c094dd3f516ecc33c50bf1835ca108d`.
The test uses a normal local WebGPU viewer and no production room.

Mounted regression tests cover single and federated model hides without optional
hash channels, preservation of user hide/isolation state, combined and overlay
owners, all-hidden geometry reshapes, show without shard replay, and removal.
The two mounted visibility tests fail against the old selector. No renderer
package API changes, new IFC geometry, or published package changes are involved.

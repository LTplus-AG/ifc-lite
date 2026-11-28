# Location Zones

The **Location zones** panel draws construction sections, takt areas or delivery areas as boxes in the 3D view and sorts the model's elements into them. Open it from the **Coordinate** group of the panel rail. A deployment can switch it off with the `data.zones` feature (see [Configuring a Deployment](./viewer-deployment-config.md)).

A zone is planning data, not part of the model. It has no link to the spatial structure and often cuts through walls and slabs. [Emitting location zones as IFC entities](../architecture/spatial-zone-emission.md) explains the design.

## Zone sets

Zones live in named **zone sets**, for example "Sections" and "Takt areas". The sets are independent, so one element can be in a zone of each set.

- Type a name and press **Set** to create an empty set, then **Add zone**.
- **Generate from storeys** creates a set with one zone per building storey. Each zone spans the horizontal bounds of the loaded models. Storeys of federated models at the same elevation (within 0.5 m) become one zone.
- Each set can be shown or hidden in the 3D view, renamed and deleted.

A zone is an oriented box: a centre, a width, height and depth, and a rotation about the vertical axis. Edit the numbers in the zone row, or press **Edit in 3D** to move, resize and rotate it with handles.

A zone can also be a vertical prism over a convex footprint polygon. Prisms come only from an imported JSON file; the 3D handles do not edit them. [Zone shapes](./mutations.md#zone-shapes) describes the format.

## How elements are assigned

The viewer compares each element's bounding box with the zones of every set:

- An element's **zone** is the zone that contains the centre of its bounding box. An element whose centre is in no zone has none.
- An element **straddles** when its bounding box reaches into more than one zone of the set. Touching a shared boundary does not count.

**Select elements in this zone** selects every element whose zone this is or that reaches into it.

## Splitting straddlers

- **Split volumes** on a set divides the volume of each boundary-crossing element between the zones it reaches. It works only for elements whose mesh is a proven closed solid; the others are skipped with the reason.
- The [Properties](./web-viewer-controls.md) panel shows the split of the selected element with **Split volume by zone**. When the zones of a set overlap, it warns that the shares double-count.
- **Export geometry** on a zone writes a GLB file with the zone's elements. Elements that cross the boundary are cut at it. Elements that cannot be cut safely are left out and counted in the message.

## Writing zones into the model

Zones stay in the viewer until you write them to the model:

| Action | Result |
|---|---|
| **Write to model** | Writes a property set `IfcLite_Zones [<set name>]` and a quantity set `IfcLite_ZoneVolumes [<set name>] (<basis>)` onto each element of the set. Pick the volume basis first: `mesh` (default), `net`, `gross` or `unqualified`. |
| Remove zone properties | Removes both sets from every element of the set. |
| **Write zones to IFC** | Adds one `IfcSpatialZone` per zone that references the elements it contains. Running it again replaces the zones from the earlier run. |
| Remove emitted spatial zones | Removes those `IfcSpatialZone` entities. |
| **CSV** / **PARQUET** | Downloads a table with one row per element and zone. |

[Zone assignment write-back](./mutations.md#zone-assignment-write-back) describes the property and quantity sets in detail. The written data is part of the model's changes, so the next IFC export carries it. Two sets with the same name must be renamed before writing. In a collaboration session, a read-only role cannot write.

## Saving and sharing zone sets

The viewer saves zone sets in the browser's local storage, so they survive a reload on the same machine. To move them elsewhere, export them as a JSON file and import that file. The file has the form `{ "version": 1, "exportedAt": "…", "zoneSets": [ … ] }`. Importing replaces every zone set in the panel. A file with another `version`, or that is not valid, is refused.

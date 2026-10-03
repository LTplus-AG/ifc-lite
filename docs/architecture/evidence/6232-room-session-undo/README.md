# #6232 public Room layout-only Undo

The new public JSON-RPC controls run on the committed Bonsai hello-wall IFC with one and two loaded models and the actual native geometry/Room runtime. They cut a candidate face before any IfcSpace exists: no IFC entities change, but the retained Room layout must get its own history head. A single `mutation_undo(n:1)` must restore that layout and preserve all IFC export bytes, records, allocator and the peer model.

Against MCP head 33175aeee with the old SDK parent, both new native controls fail: Undo consumes the preceding authored-wall operation, changing the IFC export from 80 to 60 modifications. The five existing native controls and seven new schema controls pass. After integrating qualified SDK Room repair 651a25f20 and adding explicit raw SESSION_EDIT handling, the identical 14 controls pass, with zero skips. The session marker carries no IFC mutation; its recorded compound inverse restores native layout history.

The Room advertised schema now uses the validator-supported anyOf and singleton enum rules inherited from the physical input repair. Seven schema invariants cover each action and missing nested fields before native preparation. These receipts prove the selected public protocol controls; they do not claim a browser run or current-head remote CI.

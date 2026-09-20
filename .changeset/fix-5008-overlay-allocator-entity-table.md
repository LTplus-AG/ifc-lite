---
"@ifc-lite/mutations": minor
---

`StoreEditor` seeds its overlay express-id allocator from the store's entity table as well as `entityIndex.byId`, so IFCX-origin and reconstructed collab-room stores (whose byte index is empty) no longer hand a new overlay entity an id the base model already owns (#5008). `MutationStoreShape` gains the optional `entities.expressId` member that carries those ids.

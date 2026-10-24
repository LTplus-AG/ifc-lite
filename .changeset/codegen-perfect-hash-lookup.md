---
'@ifc-lite/codegen': patch
---

The Rust emitter now writes `IfcType::from_canonical_name` as a minimal perfect hash: a 64-bit word hash of the keyword (emitted as `canonical_name_hash`, one multiply per 8-byte word) and a small displacement table pick the one candidate type, and that type's own spelling confirms the hit. The old `match` on `&str` tested every name in turn. Generation fails if two schema names share a hash. Name resolution, the `Unknown` fallback and its CRC32 id are unchanged. Test builds also get `SUPPLEMENTAL` (the types only a supplemental schema declares) and `IfcType::CANONICAL_NAME_ARMS`, so a registry test can resolve every slot.

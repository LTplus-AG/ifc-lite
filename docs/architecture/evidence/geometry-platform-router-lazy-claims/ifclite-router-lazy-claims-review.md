# Warmed router allocation regression: lazy claim ownership

Implemented uncommitted on the current shared root; no commit/index mutation, Cargo invocation, heavy command or fleet submission. Exact final source/supporting hashes are in `/tmp/ifclite-router-lazy-claims-receipt.json`.

## Concrete allocation mechanism

The reported old-source zero-allocation fixture failed 1 vs0. The router constructor eagerly evaluated `Rc::new(RefCell::new(FxHashSet::default()))` for `instanced_sources_materialized`: the empty HashSet itself allocates no backing, but Rc requires an owner allocation even when no mapped work occurs. This directly contradicts the existing unused warmed per-job router contract.

The current separately integrated common-inner code adds another such site: `mapping_program_stores: Default::default()` reached derived `MappingProgramStores::default`, whose cleanup field was `Arc<Mutex<Vec<u64>>>`. Its empty Vec allocates no payload, but Arc::default allocates the owner. Fixing only the originally reported Rc would therefore leave the current warmed constructor allocating once.

## Changes and preserved ownership

- `router/mod.rs`: marker storage is `OnceCell<Rc<RefCell<FxHashSet<u32>>>>`, default-uninitialized. The marker insertion method reaches the existing shared-handle helper. Constructor no longer creates its Rc.
- `router/mapped_cache_ownership.rs`: `materialized_source_handle` initializes that one Rc on first reached template work and clones the same owner thereafter. It does not create a new marker set per request or deep-copy source maps. Existing provisional claim holders retain their strong Rc independently of router lifetime.
- `router/mapping_program_store.rs`: cleanup storage is `OnceCell<Arc<Mutex<Vec<u64>>>>`. Its accessor initializes once on actual mapped-program cleanup ownership. `drain_mapping_cleanup` returns without initializing when no queue has ever been issued. Once issued, clones and deferred IDs use the same Arc as before; actual store cancel/drop and claim rollback semantics are unchanged.
- `router/mapped_cache_ownership_tests.rs`: added `lazy_template_claim_owner_survives_router_drop_and_rolls_back_unaccepted_geometry`. It admits an actual mapped triangulated source through SubmeshWalk under a real account, reaches the actual provisional template mark, then drops the router while the external execution store still owns that pending claim. Cancelling that store must remove the mark through the retained original Rc. A subsequent independent router emits actual triangle geometry, not an empty template placeholder.

The existing allocator integration assertion `issue_3987_warmed_router_construction_allocates_no_unused_registry_or_schema` remains completely unchanged. Existing actual abandonment tests (`styled_inner_claim_store_cancels_only_incomplete_materialization`, `common_mapping_abandonment_hands_claim_cleanup_back_to_its_router`) remain applicable to source marker rollback, cleanup queue delivery and retained completed cache payloads; none was weakened. This is a mechanism fix, not an increased allocation allowance or numerical optimization claim.

The OnceCell containers themselves have inline empty representations. No Rc/Arc creation is reached by these two default constructor fields until their actual accessors are called. That is source-level allocation reasoning; the full zero-allocation invariant must still be executed against the current integrated constructor.

## Validation boundary

Pinned rustfmt parse-only with `--emit stdout --config skip_children=true` succeeded for the four edited files, output `/tmp/ifclite-lazy-router-claim-syntax.log`; source was not formatted in place. `git diff --check` passed for those paths. No type-check, Clippy, allocator measurement or geometry test was run under refused capacity. New and existing behavioral assertions remain UNRUN on this final source. No elapsed-time, RSS, platform or SDK surface qualification claim is made.

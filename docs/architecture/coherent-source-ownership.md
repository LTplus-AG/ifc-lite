<!-- SPDX-License-Identifier: MPL-2.0 -->
# Immutable source and model-context ownership

`ifc_lite_core::SourceBundle` owns original bytes and their canonical entity
index. `scan_with` fuses the existing byte scanner with native classification;
only scanner-produced rows enter the adaptive index builder. The builder moved
from processing to core without changing hash/dense/columnar selection, duplicate
precedence, wide-offset handling or shared lookup caches. `columnar` uses the
existing compact scanner directly for browser loads without delivered columns.

A bundle's decoder factory borrows the owned bytes, installs the paired index,
and retains private factory provenance. The decoder remains mutable for custom
processors and scoped worker borrowing. Index setters remove that provenance.
A pristine unindexed decoder reading the exact owned allocation can adopt the
canonical index. Populated borrowed decoders and independently installed indexes
cannot acquire authority; canonical prewarming starts with a factory decoder.

`with_columnar_index` admits delivered columns by checking every canonical span
and completeness once against the original bytes. It reuses the delivered
allocation. Equal lengths, IDs, allocation addresses and asserted tokens are
insufficient. Different contents with the same correct record boundaries may
legitimately use the same span table: an index maps spans, not attribute values.
No lossy UTF-8 conversion, source digest or per-product index walk is involved.
Validated span reuse never imports another source's already populated inverse
lookups. Coherent columnar StyledItem and grid-axis caches belong to the actual
bundle. Hash/dense StyledItem caches retain their decoder-local domain and refusal
attribution; this migration does not hoist those lookups model-wide.

`ProductionModel::from_source` retains the bundle in every immutable snapshot.
Owned planning, execution, reply acceptance and publication reject a foreign or
unbound decoder with `MismatchedSource` before entering that transition's owner
or geometry work. Explicit lifecycle invalidation remains `StaleSource`. New
configuration snapshots preserve prior same-source snapshots. Dropping the
factory caller does not expire retained source or styles. Dormant work can use a
fresh decoder from the same bundle; live owner and reply validation still apply.

The six-field borrowed `MeshProductionContext` and its canonical producer retain
their existing API and allocation behavior. `ProductionModel::new` deliberately
selects compatibility mode: callers must pair independently borrowed bytes and
indexes themselves. Its lifecycle stamp does not authenticate those inputs.
Native `ProcessingRequest.entity_index` retains that explicit compatibility
precondition; ordinary native loads use the coherent factory for fresh workers. The native
scan and shared prepass retain their original mutable decoder, including the
first successfully cached duplicate record and refusal state.
`install_compatibility_index` installs the bundle’s existing index without
authenticating that populated decoder or clearing its caches. Native borrowed
load bytes are copied once into owned storage, never per chunk or product.

Production appearance entry points construct one bundle per effective input.
Their existing classification and context discovery use its decoder from the
start, retaining its cache instead of creating an unrelated decoder afterward.
Appearance snapshot reuse checks the actual model owner and texture component;
the unrelated appearance source counter has been removed.

The browser geometry worker calls additive `bindSourceModel` after source/index
installation and before geometry. The handle validates delivered columns once
per worker, then all FromSource batch variants use the same factory decoder and
producer. This is an additional source scan on the delivered-index worker path;
it is necessary to validate an untrusted independently delivered span table and
requires worker-pool performance qualification. Repeated bind calls are cheap.
Existing JS exports, Rust batch signatures and raw batch return conventions stay
unchanged. Progress callbacks must not reenter the synchronous module.

Coherent style caching compares complete supplied ID/color wires and rebuilds
only on a real revision. Changed colors with identical IDs deliberately take
effect in this path. Legacy data-taking calls retain their existing cheap style
signature and documented collision behavior. Opening, material and finish
arguments remain selected on every call. Source replacement, index installation
and cleanup invalidate coherent authority at their existing boundary; shared
source-map/template clearing is factored into one helper. Configuration setters
keep their existing narrower cache boundaries. Old snapshots own their maps.

This layer does not authenticate arbitrary caller-authored jobs or configuration
maps, provide remote
credentials, own all mutable router effects, implement cache transactions or
activate a retained SMLib engine. General model/overlay revision coordination,
resource admission and source-independent geometry programs remain separate.
The source bundle certifies its bytes/index pairing; custom decoder maintenance
and extension side effects retain their existing synchronous contracts.

Semantic cache authority follows the producing decoder as well as the bundle.
`SourceCache<T>` is opaque: canonical worker point/placement memos and prewarmed
records move with private bundle/revision provenance. Checked transfers reject
foreign bundles before installing entries. Raw `inject_shared_cache`,
`set_point_cache`, `set_placement_transform_cache`, and `set_grid_axis_index`
retain their trusted-input compatibility behavior and revoke coherent authority,
even for empty imports. Adoption accepts only pristine borrowed decoders. Prewarm
through the factory instead; direct noncanonical duplicate spans never populate
its canonical last-occurrence ID cache.

Appearance authoring deliberately adds/edits entities outside immutable source
bytes. It now explicitly accepts `TrustedDecoderInputs` into a new model revision
and invalidates its previous revision. This is trusted configuration, not source
authentication; later imports do not match that revision. The same opt-in is
available for extensions. Placement memo writers still owe the existing complete
canonical world-transform contract, and supplied unit scales remain explicit
consumer configuration; source ownership does not prove arbitrary extension code
or supplied numeric configuration correct. Typed transfers prove origin and
revision without rescanning/cloning cache maps, source bytes, or index tables.

# Markdown datastore design

Source Markdown is authoritative. The extension owns configured source scope,
safe reads, caller-controlled results, Pi tools/events, and supervised maintenance.
qmd owns indexing, embeddings, ranking, model lifetime, cache storage and recovery.

## Reading map

- [Identity and source validation](#identity-and-source-validation)
- [Operations and bounds](#operations-and-bounds): [caller budgets](#result-budgets),
  [paging and applied work](#paging-and-applied-work), and implementation boundaries
- [Metadata index](#metadata-index)
- [Restrictions register](#restrictions-register)
- [Public qmd lifecycle](#public-qmd-lifecycle)
- [Refresh and recovery](#refresh-and-recovery)
- [Shared datastores](#shared-datastores)
- [Integration lifecycle and packaging](#integration-lifecycle-and-packaging):
  [request ownership](#request-and-resource-ownership) and
  [root/destination policy](#public-root-and-destination-policy)

## Identity and source validation

Each trusted project supplies protected strict JSON configuration at
`.pi/markdown-datastore/config.json`. Project store aliases are unique. Private definitions keep root and collection
uniqueness within their project-owned backend. Shared definitions have canonical
catalog IDs and independent backend namespaces; a backend-local collection name
may recur in another shared index. Explicitly different index definitions may
use the same source root. Paths alone do not identify a datastore. Unknown/duplicate keys and unsafe configuration authority
paths fail closed. Configuration is current-user-owned, at most 64 KiB and mode
0600; authority directories have checked ownership and permissions.

A configured root must name a real directory, without symlink aliases in the
root or its ancestry. Its canonical path and device/inode identity are captured.
Direct opens reject descendant symlinks, multiply linked files, traversal, unsafe
file types, invalid UTF-8, root replacement and oversized files. Scans skip
symlink entries rather than following them and refuse selected hard-linked notes.
Source permissions and bytes are never rewritten, moved, or repaired. Exact paths
and canonical datastore URIs identify notes.

The normal include pattern is `**/*.md`. Existing include/exclude patterns select
scanning and indexing, not access control: exact direct find/read can access
otherwise valid Markdown excluded from those selections. The configured root is
the containment and ownership boundary.

The qmd 2.8.3 SDK returns literal collection-qualified paths. The adapter checks
the collection and validates the relative path without URL decoding or filename
normalization. Public `getDocumentBody()` supplies the indexed text; its SHA-256
is compared with safely opened source bytes before returning a hit. This is our
source revision check, not an interpretation of qmd's hash or chunk offsets.
Changed, missing or unsafe candidates are dropped with a warning. Direct reads
are independent of index state.

Lowercase kebab-case/numeric paths are the primary managed-store convention.
Qualified fixtures also cover spaces, Unicode, punctuation and literal percent
escapes. Paths containing control characters, backslashes, query/fragment
markers or traversal segments are rejected for qmd search identity. Filesystem
case sensitivity still applies. A complete inventory or continuously current
snapshot is not promised: counts come from public backend status, and freshness
records successful reconciliation plus per-result validation. External additions
may be absent until the next explicit/startup reconciliation.

## Operations and bounds

### Supported operations

`datastore_find` accepts exact `.md` paths, datastore URIs, and a single frontmatter tag. A tag query uses the same one-leading-`#` identity as the index.
`datastore_read` provides content, section, direct heading outlines, `links`, and `backlinks`. An attachment may be the subject of a backlink read; that read does not open the attachment as Markdown. Raw frontmatter is available through content reads with `includeFrontmatter`.
`datastore_tags` lists tag identity, display spelling, and distinct page count. `datastore_refresh` mode `metadata` builds that index without qmd.

`datastore_search` supports lexical, semantic and hybrid requests. Its data
includes requested/effective mode, queue and public-operation elapsed time and
worker PID; these are observations, not cache-hit or model-load measurements.
Warnings are preserved in the tool and event envelopes. Consumers must retain
them when displaying results. Strict freshness rejects unreconciled state or
changed candidates. Semantic retrieval requires complete backend embeddings;
`allow-stale` does not select an older semantic snapshot.

### Result budgets

Datastore supplies local knowledge, not a model-context policy. `maxBytes` and
`maxLines` are optional caller controls on every public result operation: search,
find, all read views, tags, status, refresh/cancel, roots and destination validation.
The same contract applies to tools, event clients and shared hosting.

Each omitted dimension uses an explicit `defaults.maxResultBytes` or
`defaults.maxResultLines` if configured; otherwise it is unbounded. A caller value
is a positive finite safe integer and overrides the configured default rather
than being clamped to it. Invalid values are rejected. No helper, formatter or transport
adds a replacement ceiling. Existing finite configuration remains effective until
the operator deliberately changes it.

Results retain provenance, bounds and warnings. `bounds.maxBytes` and
`bounds.maxLines` use JSON null for an unbounded dimension, never JSON infinity.
Byte budgets and `returnedBytes` cover the complete serialized envelope, including
metadata. Logical payload lines count a final newline as a terminator, not an
extra empty line; snippet lines aggregate across hits independently of JSON
formatting. Search excerpts select current relevant body paragraphs, exclude
frontmatter and do not interpret backend chunk offsets or impose a separate size
ceiling.

### Paging and applied work

Pageable results fit the actual full envelope and provide a continuation when
more remains. Content fitting makes progress without a fixed attempt count and
allocates only a token that will be returned; failed trials cannot evict earlier
tokens. Caller budgets can change on later pages without changing the token's
selection, cursor, source revision or query. Otherwise valid older finite tokens
retain their meaning.

Body/section continuations and section handles are revision-bound, expire after
15 minutes and occupy the existing 256-entry registry. Metadata continuations are
stateless store/index-revision/query-bound tokens with no separate lifetime.

A nonpageable status, policy or receipt is not silently projected, stripped of
fields or truncated into invalid JSON to fit a budget. If an honest result cannot
fit, even at its minimum envelope, the call reports `RESULT_LIMIT_EXCEEDED` rather
than raising the caller's value. An error is not itself promised to fit an
impossibly small result budget. Root policy never returns an incomplete authority
scope as though it were complete.

Budget validation precedes maintenance admission or cancellation. If work has
already been applied when its response fails the budget, error details retain
`operationApplied: true` and `refreshIds` with every actual known job ID. Shared
and event clients preserve this outcome; model-facing error text includes the IDs.
A response failure does not replay, cancel or terminalize the accepted work.

### Budget flow and compatibility

`contract`, `client` and `index` own typed inputs, discovery, tool schemas and
result/error serialization. `config-common`, `config` and `shared-catalog` resolve
the optional controls; `service`, `markdown`, `metadata-index` and `continuations`
apply them while preserving source and paging identity.

Discovery and the shared handshake advertise `resultBudgetVersion: 1`. A new
client reports `CAPABILITY_UNAVAILABLE` rather than silently promising unbounded behavior
from an older bounded owner. A client's selected budget does not become catalog
policy for other clients. Output-budget changes do not change source/index
identity or themselves require an index rebuild.

Result sizing is separate from query selection, source-file validation, retention
and execution policy. Existing limits include 10 MiB per source file, 20 search
hits, 500 backend candidates and 100 outline entries. Their effective values and
unresolved approvals remain in the [restrictions register](#restrictions-register).

## Metadata index

Wikilink edges and frontmatter tags are a source-derived index beside qmd.

### Snapshot and target resolution

The committed snapshot is one JSON object with `files`, stem-only `targets`, tag membership, and written-target `references`, plus revision, source-root identity, completeness, and diagnostics. A file link stores the written target, not a resolved path. Resolution happens when a link or backlink is read, against the current target list, so adding or removing a candidate changes resolution without reparsing the referring note. A missing shorthand target keeps an empty target entry. An explicit path is a reference, not an extra target alias.

### Incremental maintenance and ownership

An unchanged content revision updates only the recorded timestamp and keeps that file's diagnostics. A path update with no snapshot, or a snapshot for a different source root, rebuilds that root instead of publishing a partial or merged index. A later path update changes only that file's lookup contributions. A failed lexical reconciliation stays due on the next cycle even when the graph is already current, and is cleared only by a successful lexical job. Shutdown stops the cycle timer before settlement and does not rearm it. `reconcile` compares inventory and timestamps, then opens changed notes. `rebuild` rereads every note and ignores stored timestamps. The four objects are replaced together; a failed write leaves the previous snapshot in memory and on disk. Dictionary keys are own properties, including names that would otherwise be inherited.  The maintenance coordinator and its job file live at the application state root and are created before qmd. Qmd receives that coordinator. The metadata index stays there when qmd is disabled or unavailable.

### Parsing and tag identity

Ordinary Markdown links are not edges. A backslash in a wikilink is unsupported syntax, not a path separator. Code identified by the Markdown parser is not an edge. One leading `#` is removed from a tag identity, once, for both indexing and query. A tag catalog entry is an identity, the retained display spelling, and the distinct page count.

### Read admission and freshness

Relationship and catalog pages use the existing result envelope and the same caller budget resolution and full-envelope fitting. A continuation is bound to the store, the index revision, and the query. It is not a registry entry and has no separate lifetime. A query admits the indexed source root, the returned note by the source revision observed at refresh, and an attachment by contained-file inspection of size and mtime. It does not read an attachment body and does not claim a content hash for one. An incomplete scan or a changed returned note is stale, not current. Direct reads stay available when this index is rebuilding. The host acquires that stable directory before admission and releases it only after accepted work has settled. Capability discovery adds `metadata.links`, `metadata.backlinks`, and `metadata.tags` without removing the older ready, store, contract, or policy fields.

### Durable path scopes

Metadata receipts own their admitted paths or explicit rebuild intent. A queued scope can coalesce more paths only after the combined scope is durably written; a rejected merge restores the earlier accepted scope before execution. New paths cannot change a running scope: they receive a queued follow-up without waiting for the running maintenance to finish. Explicit cancellation discards that receipt's work, not newer independently admitted notifications. Qmd jobs do not claim metadata paths.

## Restrictions register

Review in every PR against implementation, tests and dependency behavior. The
following are effective constraints, not approval of their values. Unless stated,
explicit numeric/policy approval and supporting necessity evidence remain to be
mapped. Configuration owners are component maintainers for fixed values, project
configuration for exposed settings, and test maintainers for fixtures. Surface
additional encountered restrictions rather than assuming this list is exhaustive.

| Restriction | Why (what failure does it prevent) |
| --- | --- |
| Common reconciliation interval 300000 ms. Location: `MaintenanceCoordinator.startCycle`, private `bindMetadata` and shared host. Approved by Sean for this maintenance cycle on 2026-11-12. | Keeps graph and tag metadata current between publications without a second scheduler. It does not approve other inherited deadlines. |
| Configuration size 64 KiB/mode `0600` and canonical configured root/file identity, link, type and UTF-8 checks. Locations: `src/config.ts`, source access helpers. | Enforces the described namespace/configuration authority contract while keeping source unchanged. Specific mode/path-exclusion approval references remain unestablished; same-account processes are not new hostile principals. |
| File 10 MiB, search 20 results, backend candidates 500, outline 100 entries; continuation registry 256 entries/15 minutes. Locations: configuration, search/read and continuation code. Omitted result byte/line budgets are unbounded. An explicit configured or caller budget is honored and is not a hidden maximum. Approval for the remaining numeric limits is not established. | Prevents unbounded source reads and unbounded candidate selection. It does not authorize a result-size ceiling. |
| Configured reader operation timeout 100-60,000 ms; service ceiling 900,000 ms; client default 900,000 ms and allowed range 1-900,000 ms; maintenance update/embed deadline 35 minutes. Locations: config, service, client and qmd lifecycle code. | Aborts work under different queue/execution scopes described below. These are our chosen envelopes, not automatic approval from qmd/Pi. Numeric approval remains missing; a durable refresh receipt is not completed maintenance. |
| Two supervised workers, serial maintenance, maintenance semantic-admission drain; idle exit 5 minutes with injected range 25-300,000 ms; automatic semantic batching 5 minutes. Locations: qmd adapter/worker clients. | Implements the described coordination/model-release behavior. Concurrency, cadence and idle values require explicit approval evidence, not inference from dependency defaults. |
| Worker diagnostic stderr 1 MiB, cancellation TERM 100 ms/KILL 250 ms. Location: `src/qmd-worker-client.ts`. Request and result frames are not rejected for size. | The stderr cap and kill escalation remain. Their approval is not established. They are not result budgets. |
| Metadata preflight 100,000 documents/512 MiB; latest 20 job records subject to active-job bound. Location: `src/qmd-adapter.ts` and maintenance state. | Limits scan/admission metadata and retained receipts, not transactional index correctness. Numeric rationale/approval remain unestablished. |
| Default test child 300,000 ms; package outer 60,000 ms/subprocess 30,000 ms; facade cases 5,000 ms; worker/CLI subprocess 10,000 ms and CLI capture 1 MiB; opt-in native cases 90,000 ms/180,000 ms. Locations: `scripts/test.ts`, package/facade/qmd/worker/CLI tests. | Functional qualification can fail solely because a host/backend is slow or verbose. Fixture/opt-in status and green tests do not establish owner approval for these budgets. |
| Publication content matching uses the README registry rules. Location: `scripts/check-private-terms.ts`; registry paths are configurable with `PRIVATE_TERMS_FILE`/`PRIVATE_SECRETS_FILE`. | Rejects matching private terms and credential values; matching-policy evidence is distinct from the revision-range correction and output cap. |
| Existing-branch publication scans exclude `origin/main` ancestry; new branches exclude known remote history. Location: `.githooks/pre-push`. | Approved correction in PR #13 prevents published main history from blocking clean updates; feature checks remain. |
| Publication scanner Git-output capture is 256 MiB. Location: `scripts/check-private-terms.ts`; fixed by scanner maintainers. | Can reject large captured Git output. Specific necessity/approval is not established by the registry or revision-selection rules. |
| Operator-managed user LaunchAgent with `RunAtLoad=true`, documented in `docs/setup.md`; no `KeepAlive` or custom launchd deadline in the example. | Starts the shared catalog service at OS-account login independently of client connections. Operator owns installation and lifecycle; accepted by Sean during PR #13 review. It does not provide pre-login boot startup or authorize live activation. |
| Shared catalog uses protected JSON, the inherited 64 KiB configuration bound and one include pattern per native collection; the socket parent is owner-only and the socket mode is `0600`. Locations: `src/shared-catalog.ts`, `src/shared-ipc.ts`; catalog values belong to the operator. | Canonical definitions and owner-account-only local IPC are approved in issue #4. The catalog reuses existing reader/file/operation ranges rather than selecting a new transport deadline or frame cap. Reuse does not approve legacy numeric bounds; the single-pattern mapping follows the qualified qmd collection interface. |
| Metadata catalog and relationship pages use caller budgets in the common result envelope. Location: `src/service.ts`. The inherited 20-job and 256 KiB ledger checks remain in the common coordinator. | A finite response is explicitly partial with a continuation or reports that it cannot fit; unbounded results may include the complete catalog. No new item cap or continuation TTL is added. The independent ledger limits retain their unresolved approval gaps. |
| Explicit terminal-history initialization requires an absent stable ledger, validated terminal-only history and existing exclusive application/historical ownership. Locations: `maintenance-migration` and its operator CLI. Owner-directed receipt-preserving recovery, 2026-11-14. Existing per-ledger 20-job/256 KiB schema checks are reused; their numeric approval remains unresolved and no total-history cap is added. | Prevents abandoning unfinished work, replacing a current queue or guessing a historical source identity. Automatic adoption remains strict. Inspection uses protected disposable copies; original receipts and native qmd storage remain untouched. |
| Frontmatter depth 8, 1,000 nodes, 16 KiB strings, and 10 YAML aliases. Location: `src/markdown.ts`. Exceeding one fails the note as `FRONTMATTER_INVALID`. | Bounds YAML walked while parsing notes. Issue #2 surfaced these inherited values. This table records them. It does not approve them. |
| One maintenance owner per derived index, independent of IPC path. Protected ownership directory `0700`, records `0600`; live or unverifiable owner/worker PIDs refuse admission. Locations: `src/index-ownership.ts`, `QmdAdapter`, native-worker registration. | Approved single-index ownership and operator restart without manual dead-owner cleanup, issue #4 and the owner's 2026-11-12 recovery decision. Atomic nonempty-directory admission prevents simultaneous reclaimers replacing one another. Only proven-dead process records are reclaimed; no lease timer, election, process killing or autostart. PID reuse is conservatively treated as live, not guessed dead. |

## Public qmd lifecycle

The qualified release is exactly `@tobilu/qmd` 2.8.3. The package's public export
is bound to the selected installation and revalidated before work. Runtime calls
are `createStore`, `searchLex`, `searchVector`, `search`, `getDocumentBody`,
`update`, `embed`, `getStatus`, `getIndexHealth`, `listCollections`, and `close`.
The documented CLI `search --format json --full-path` is also exercised by
compatibility tests. No runtime path recovery through the CLI is needed for this
SDK release.

Two lazily created supervised processes share one durable index: one search
worker and one maintenance worker. Each owns its public store for its lifetime
and calls public `close()` on idle/shutdown. Five-minute idle exit releases
models; reopening retains native on-disk state. Search reuses this durable index.
qmd controls cache reuse, pruning and update invalidation. Explicit refresh may
invalidate cached queries even if little source content changed.

Worker IPC stream errors are contained within the datastore, including writes
for requests, cancellation and shutdown. An unusable child is retired and the
affected call settles once; its late events cannot affect a newer child or call.
A failed operation is not replayed. A later independent call can open a new
worker after retirement. Child liveness checks do not replace stream error
handling because an idle exit can race with a write before exit events arrive.

Maintenance admission closes semantic admission before dispatch and drains
already admitted reads. During maintenance, independent lexical reads remain
available. Hybrid falls back only for this known maintenance interval, with a
warning and effective lexical mode. Semantic-only calls fail promptly with a
retryable error. Pending embeddings alone do not imply an active job. No fallback
is applied to arbitrary backend failures, empty results or incomplete embeddings.
External maintenance must not run against an owned index concurrently.

Workers use v2 JSON frames and filtered environments. Valid request/result frames
have no fixed size ceiling; diagnostic stderr has its separately registered bound. Caller cancellation
terminates the owned process with bounded TERM/KILL escalation and waits for
exit. The SDK does not accept an AbortSignal. Dispatched qmd reader requests use
configured `operationTimeoutMs`, excluding their preceding queue wait. A native
update/embed maintenance-worker request has a separate 35-minute deadline,
excluding preceding maintenance queueing and metadata scanning. Service
operations have a 15-minute ceiling. The cross-extension client defaults to 15
minutes, with caller overrides within its existing 1-900000 ms range. A refresh
invocation returns a durable receipt before background maintenance completes;
its caller deadline is not the background job's deadline. Progress counters are
observations and may reset between collections or native batches. Progress
cannot extend the hard maintenance deadline.

Native SDK embedding has a session cap and may produce partial work. Success
requires no reported embedding errors and zero pending embeddings. Partial work,
cancellation and failure leave search freshness unknown until reconciliation;
there is no rollback guarantee. Before update, metadata preflight walks selected
files and checks containment, file types/link handling, per-file sizes, and
aggregate limits of 100,000 documents and 512 MiB. It does not open and UTF-8
decode every note. Later qmd content reads and direct/search-result validation
are separate. Preflight does not establish exact backend membership.

## Refresh and recovery

Qmd's derived directory is specific to the release and configuration. The common application ledger and metadata index are not. They live at the application state root and are created before qmd. A new qmd binding does not move that ledger. Startup loads it and relaunches queued metadata work. Queued qmd jobs stay pending when no qmd runner is registered. If the stable ledger is absent, startup inventories `qmd-public-VERSION-FINGERPRINT` children, recomputes that path from the recorded version and current store config, and adopts exactly one proven application `jobs.json` after the ledger schema check and an index-ownership lease. A live or uncertain owner, two ledgers, or a path that does not recompute is an explicit compatibility failure. An existing stable file is not replaced. This does not open or migrate qmd's native databases. Each accepted job is bound to its own target-store subset. Metadata identity ignores qmd availability. Lexical and semantic identity also retains the backend version and collection. A saved job whose definition is missing or no longer matches stays queued. It is not executed on the new definition and does not coalesce with new work. The operator can restore the matching definition or explicitly cancel and reissue. There is no automatic migration or retry. A legacy ledger is stamped only from the definition that proved its origin, and only for each job's own stores. Job receipts and reconciliation
metadata are published atomically. They do not make native index writes atomic.
When qmd is available, startup also requeues interrupted qmd jobs and schedules lexical reconciliation. Identical
active jobs coalesce; different requests serialize. Cancelling a request waiter
does not cancel shared maintenance; explicit cancellation owns that decision.
The latest 20 job records are retained, subject to the active-job bound.
### Explicit terminal-history initialization

An operator may inspect the application state with `maintenance-migration-main`
and explicitly initialize its absent stable ledger when all retained legacy work
is terminal. This is a fresh active queue, not adoption of a historical source
definition. Every historical application ledger remains byte-for-byte in place,
including receipts outside the active queue's retention window. The report lists
their paths, SHA-256 values and job counts. No historical job is replayed,
rebound, cancelled or copied into the current queue.

The command validates protected copies through the existing coordinator schema,
never normalizing the original receipts. Inspection does not change live state.
Initialization acquires the application and historical ownership leases,
revalidates the inventory and hashes, and atomically publishes only the absent
`jobs.json`. Queued/running work, a live or uncertain owner, malformed history or
a changed inventory prevents initialization. Existing stable state is never
replaced. A later runtime start loads the ordinary empty version-1 ledger and
keeps the normal strict automatic-adoption behavior unchanged. Operators retain
the inspection/initialization reports with their deployment evidence and obtain
separate runtime stop/start authorization. No native qmd storage is opened.

### Backend reconciliation and recovery

A backend refresh failure marks the index for rebuild on the next lexical
reconciliation: close both public stores, quarantine the entire opaque backend directory,
and build a fresh index from all configured collections. Successful recovery
publishes freshness for every collection actually reconciled, not only the
requested subset; a collection with another outstanding maintenance job remains
unreconciled until that job completes successfully. Lexical recovery schedules
semantic batching for its actual reconciled scope. Job keys and store lists
retain the original requested scope, and failed receipts remain historical:
per-store reconciliation currency can therefore be newer than its latest
store-targeted receipt. Quarantine cleanup is an operator action with the service
stopped. No live database files are copied.

Omitted refresh mode defaults to `direct`: it only revalidates captured root
identities, without scanning notes or updating indexes, and returns the bounded
root-check result. `lexical` queues a qmd update and schedules semantic batching
after success. `semantic` queues update plus embedding; `all` currently follows
the same path. These three modes return durable job receipts. Explicit refresh
enters the serialized maintenance queue without the automatic batching delay.
Automatic semantic batching waits five minutes after lexical refresh without postponing the window for later requests. Empty
or fully embedded ticks do not update. Failed embedding jobs remain failed until
an explicit retry; there is no automatic infinite retry of a bad document.
The common coordinator checks source inventory every five minutes, reconciles changed metadata first, and then schedules due lexical work. A current graph does not clear failed or pending qmd reconciliation.

## Shared datastores

A project store is either private or an explicit reference to a shared catalog entry. The reference selects a canonical store id. It does not create an index, and the local alias is not a second definition. Same path is not identity: deliberately configuring a private and shared definition over one source folder creates independent indexes, not two views of one index. Projects referencing the same canonical catalog entry share its index. Direct find, read, outline and root policy stay in the project against the resolved source root.

Indexed search, refresh, status and job cancellation for a shared store go to one foreground local service. The maintenance owner is `MaintenanceCoordinator`. `MetadataIndex` and `wiki` own graph and tag state. `QmdAdapter` is the optional qmd backend and is injected with that coordinator; it does not own the common ledger. The catalog's `qmd.enabled: false` disables native adapter creation regardless of installed packages. Graph-only and qmd-unavailable stores still have one coordinator and one metadata index per canonical store; accepted metadata jobs remain cancellable through that coordinator without a backend. The project does not keep a second coordinator or a private replacement index. If the service is unavailable, shared indexed operations fail and direct reads continue. Shutdown settles accepted work before releasing ownership.

The service runs with `--catalog` under operator control, either manually or through one operator-installed macOS user LaunchAgent for the catalog. Its import path uses only production dependencies: `config-common` owns shared budgets and strict JSON validation, while `config` retains Pi-dependent project-path resolution for the hosted extension. A packed foreground-service test installs without Pi/TypeBox peers and verifies startup and graceful shutdown independently of the extension loader. The LaunchAgent starts it at account login, including login after reboot; it is not a pre-login system daemon. The service and its reconciliation cycle remain available with zero clients. Projects only connect to its configured owner-only socket: they do not install, launch or own the service or its LaunchAgent, and client attachment counts do not control its lifetime. Setup documents startup, inspection, deliberate restart and stop commands. Closing a project closes that client's waiters and any in-progress attachment. Attachment belongs to the client lifetime, so cancelling the first handshake waiter does not cancel other callers using that same attachment. It does not cancel an accepted shared job or rebuild the index. Replies must match the attached definition and live generation. Restarting the service creates a new generation. A request bound to the previous generation or a different definition revision fails instead of being retargeted. Definition revisions include captured source-root device/inode identity, so replacing a root at the same path invalidates old attachments.

`src/index-ownership.ts` admits one owning maintenance unit for the actual derived index before the host changes its endpoint or starts reconciliation. A different catalog or socket does not bypass that guard. A complete, nonempty ownership generation is published atomically. Native workers register before SDK access; a surviving worker prevents a replacement owner even after its parent has exited. Graceful shutdown stops requests/workers, persists receipts and releases ownership. After an unclean exit, an operator-started replacement reclaims proven-dead records and uses the same interrupted-job reconciliation. Live or unverifiable process identity remains unavailable rather than being killed or silently replaced. The component does not restart itself or launch a replacement on client connection; the operator manages startup and restart, including the optional login LaunchAgent.

Private stores use the same coordinator, metadata index, and admission algorithm. Qmd, when present, is a backend on that coordinator, not a second owner of the metadata directory. Search validation, aggregate budgets/warnings and status readiness use common private/shared paths; receipts and reconciliation present the project's local store aliases while underlying refresh IDs and queue keys remain canonical.

## Integration lifecycle and packaging

The operation identifier is `pi-markdown-datastore:v1:request`. Pre-release
clients and the service must be rebuilt together; there is no alias for the
earlier identifier. Policy requests add an optional envelope `instanceId`; it is
required only for the two policy operations.
The pure `/client` transports v1 request IDs, deadlines, combined cancellation,
and one-shot settlement; it validates response envelopes. Invalid schemas,
expired requests, and duplicate responders retain their existing rejection/
diagnostic behavior.

Discovery has separate owned identifiers
`pi-markdown-datastore:v1:capability-request` and
`pi-markdown-datastore:v1:capability-reply`. The responder registers during
initialization. Replies report protocol/contract version 1, service readiness,
configured store names, and optional `policyVersion: 1` plus `instanceId` for the
supported policy API. No paths or write grant are returned by discovery. The
query subscribes, emits, and unsubscribes synchronously. Missing services return
immediately; malformed/incompatible or duplicate replies grant no capability.

### Request and resource ownership

Request-owned buffers, timers, abort handlers, waiters and subscriptions are
released when the request succeeds, fails, is cancelled, disconnects or shuts
down. Retired stream error handlers still consume late errors without letting an
old child affect a newer call. Shared waiter detachment does not cancel accepted
maintenance.

`qmd-worker-client` collects frame fragments and assembles a completed frame once,
rather than repeatedly copying its growing prefix. Drained backing storage and
incomplete storage on retirement/close are released; a tiny tail does not retain
an already consumed frame. `shared-ipc` releases partial frames and data/close
subscriptions on close or parse failure. Neither path stores an additional
long-lived serialized-result cache.

Caller-held results, the current derived metadata snapshot, descriptor-only
continuations and intentionally warm SDK workers have legitimate separate
lifetimes. Resource cleanup does not imply zero-copy processing, immediate GC or
a promise to recover from arbitrary memory exhaustion. These ownership rules are
independent of caller output budgets, not a reason to impose another result cap.

### Tool schemas and readiness

All six model-facing tools use object-root parameter schemas. Conditional
`anyOf`/`oneOf` object branches explicitly declare their object type, including
presence constraints inside `not`, so provider validators do not infer a
non-object union. Refresh uses flat root alternatives for start without paths,
metadata start with paths, and cancellation: xAI rejects the equivalent nested
start/path choice even when its branches declare object types. The
read-view/continuation and refresh-action exclusions remain part of the schema
and runtime validation.

All six model-facing tools and the event responder register independently of
configuration success. Configuration/backend construction occurs in
`session_start` after project trust. Missing/invalid configuration disables
operation, not visibility: calls retain the actual configuration error code.
Untrusted projects fail with `PROJECT_UNTRUSTED` without loading configuration or
starting a backend. Optional qmd failure does not disable valid direct operations.
Consumers query during Pi's `resources_discover`, which runs after all start handlers and works in either load order without retry timers. Earlier
queries may see an unready service. Retained capability getters become unready
and expose no stores when their generation is replaced or shut down. Consumers
discard references at teardown/reload and query the new session again. Backend
index readiness still comes from `status`, not the service-ready bit.

### Public root and destination policy

The supported `/client` adds `roots({})` and `validateDestination({ path })`.
Consumers must discover `policyVersion: 1` and construct the client with
`{ capability }`. The client binds these requests to that capability's
`instanceId`; the service rejects a mismatched instance with `STORE_UNAVAILABLE`.
Retained capability getters lose their instance ID on session replacement or
shutdown, so a retained client rejects policy calls with `CAPABILITY_UNAVAILABLE`
instead of using the next session. Existing five-operation clients need no new
options. A missing policy capability is not an empty root list or permission.

`roots` returns `data.roots` entries `{ store, path, device, inode }` for every
effective configured store, including absolute/shared roots. Paths are canonical
and unredacted; model-facing status stays redacted. Each policy operation
revalidates all captured real-root identities. An invalid root fails the entire
operation, even for a destination outside the other roots. Missing/invalid or
untrusted configuration returns its specific error, never successful empty scope.

`validateDestination` takes an absolute local destination and returns
`{ path, owned, stores }`. Exact roots and nested destinations are owned regardless
of extension or include/exclude selections. Sibling-prefix lookalikes and files
beside a datastore directory are outside; a parent directory is not owned merely
because a store exists beneath it. The consumer must reject writes when `owned`
is true. This is ownership evidence, not general write authorization.

Existing destination ancestry is checked with filesystem metadata and canonical
path identity. Missing suffixes are supported without creating anything. Symlinks
(including dangling and ancestor aliases), multiply linked existing files,
non-directory ancestors, unsafe file types, noncanonical case/Unicode aliases,
and traversal components fail explicitly. Supply real absolute paths, including
canonical system-directory spellings on hosts with aliases. Both operations use
the existing service/client cancellation and deadlines but require no qmd,
indexing, note-content scans, model calls, or session/journal writes.

The result is an operation-time observation, not a reservation, atomic publication
authorization, or continuously current snapshot. Consumers check the actual file
destination before work and again at publication, discard references at teardown,
and keep their own project/configuration exclusions, egress and save rules.

`dist/index.js` is the single explicit Pi entry. Pure `/contract` and `/client`
exports do not activate it. Compiled ESM rewrites runtime relative imports to
`.js`, and `qmd-worker.mjs` ships beside `qmd-worker-client.js`. Production
dependencies are only owned Markdown/YAML parsing libraries. Imported Pi/TypeBox
host packages are peers; explicit development pins are separate. Tests and
synthetic fixtures do not ship. Packed-loader tests use disposable projects and
prove discovery, direct operations, missing-backend behavior, and worker
resolution without Telegram, observability, or private source checkouts.

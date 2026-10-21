# Markdown datastore design

Source Markdown is authoritative. The extension owns configured source scope,
safe reads, bounded results, Pi tools/events, and supervised maintenance. qmd
owns indexing, embeddings, ranking, model lifetime, cache storage and recovery.

## Identity and source validation

Each trusted project supplies protected strict JSON configuration at
`.pi/markdown-datastore/config.json`. Store names, canonical roots and collection
names are unique. Unknown/duplicate keys and unsafe configuration authority
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

`datastore_find` accepts exact `.md` paths and datastore URIs.
`datastore_read` provides content, section and direct heading outlines. Raw frontmatter is available through content reads with `includeFrontmatter`.

`datastore_search` supports lexical, semantic and hybrid requests. Its data
includes requested/effective mode, queue and public-operation elapsed time and
worker PID; these are observations, not cache-hit or model-load measurements.
Warnings are preserved in the tool and event envelopes. Consumers must retain
them when displaying results. Strict freshness rejects unreconciled state or
changed candidates. Semantic retrieval requires complete backend embeddings;
`allow-stale` does not select an older semantic snapshot.

Results retain provenance, bounds and warnings. Limits include 32 KiB/800 lines
per envelope, 10 MiB per source file, 20 search hits, 500 backend candidates and
100 outline entries. Continuations and section handles are revision-bound,
expire after 15 minutes, and live in a bounded 256-entry registry. Snippets use
current body paragraphs, exclude frontmatter, and obey 1024-byte/30-line and
aggregate limits. They do not interpret backend chunk offsets.

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

Maintenance admission closes semantic admission before dispatch and drains
already admitted reads. During maintenance, independent lexical reads remain
available. Hybrid falls back only for this known maintenance interval, with a
warning and effective lexical mode. Semantic-only calls fail promptly with a
retryable error. Pending embeddings alone do not imply an active job. No fallback
is applied to arbitrary backend failures, empty results or incomplete embeddings.
External maintenance must not run against an owned index concurrently.

Workers use bounded v2 JSON frames and filtered environments. Caller cancellation
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

State directories are specific to the release and configuration, so a new
configuration does not migrate the previous index. Job receipts and reconciliation
metadata are published atomically. They do not make native index writes atomic.
Startup requeues interrupted jobs and schedules lexical reconciliation. Identical
active jobs coalesce; different requests serialize. Cancelling a request waiter
does not cancel shared maintenance; explicit cancellation owns that decision.
The latest 20 job records are retained, subject to the active-job bound.
A backend refresh failure marks the index for rebuild on the next explicit
refresh: close both public stores, quarantine the entire opaque backend directory,
and build a fresh index from all configured collections. Quarantine cleanup is
an operator action with the service stopped. No live database files are copied.

Omitted refresh mode defaults to `direct`: it only revalidates captured root
identities, without scanning notes or updating indexes, and returns the bounded
root-check result. `lexical` queues a qmd update and schedules semantic batching
after success. `semantic` queues update plus embedding; `all` currently follows
the same path. These three modes return durable job receipts. Explicit refresh
enters the serialized maintenance queue without the automatic batching delay.
Automatic semantic batching waits five minutes after lexical refresh without postponing the window for later requests. Empty
or fully embedded ticks do not update. Failed embedding jobs remain failed until
an explicit retry; there is no automatic infinite retry of a bad document.
Broader automatic lexical indexing cadence is not enabled.

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

All five model-facing tools and the event responder register independently of
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

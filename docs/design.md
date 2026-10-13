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

Configured root symlinks resolve once to captured device/inode identities.
Direct opens reject descendant symlinks, hard links, traversal, unsafe file types,
invalid UTF-8, root replacement and oversized files. Source permissions and bytes
are never rewritten. Exact paths and canonical datastore URIs identify notes.

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
exit. The SDK does not accept an AbortSignal. Search has the configured operation
deadline; maintenance has a separate 35-minute deadline including native update
and embed. Progress counters are observations and may reset between collections
or native batches. Progress cannot extend the hard maintenance deadline.

Native SDK embedding has a session cap and may produce partial work. Success
requires no reported embedding errors and zero pending embeddings. Partial work,
cancellation and failure leave search freshness unknown until reconciliation;
there is no rollback guarantee. Source scanning is bounded at 100,000 documents
and 512 MiB before update. It checks source access, not exact backend membership.

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

Explicit refresh is immediate. Automatic semantic batching waits five minutes
after lexical refresh without postponing the window for later requests. Empty
or fully embedded ticks do not update. Failed embedding jobs remain failed until
an explicit retry; there is no automatic infinite retry of a bad document.
Broader automatic lexical indexing cadence is not enabled.

## Integration lifecycle and packaging

The operation identifier is `pi-markdown-datastore:v1:request`. Pre-release
clients and the service must be rebuilt together; there is no alias for the
earlier identifier. The v1 envelope is unchanged.
The pure `/client` transports v1 request IDs, deadlines, combined cancellation,
and one-shot settlement; it validates response envelopes. Invalid schemas,
expired requests, and duplicate responders retain their existing rejection/
diagnostic behavior.

Discovery has separate owned identifiers
`pi-markdown-datastore:v1:capability-request` and
`pi-markdown-datastore:v1:capability-reply`. The responder registers during
initialization. Replies report protocol/contract version 1, service readiness,
and only configured store names; no paths or service grant is returned. The
query subscribes, emits, and unsubscribes synchronously. Missing services return
immediately; malformed/incompatible or duplicate replies grant no capability.

Configuration/backend construction occurs in `session_start` after project
trust. Consumers query during Pi's `resources_discover`, which runs after all
start handlers and works in either load order without retry timers. Earlier
queries may see an unready service. Retained capability getters become unready
and expose no stores when their generation is replaced or shut down. Consumers
discard references at teardown/reload and query the new session again. Backend
index readiness still comes from `status`, not the service-ready bit.

`dist/index.js` is the single explicit Pi entry. Pure `/contract` and `/client`
exports do not activate it. Compiled ESM rewrites runtime relative imports to
`.js`, and `qmd-worker.mjs` ships beside `qmd-worker-client.js`. Production
dependencies are only owned Markdown/YAML parsing libraries. Imported Pi/TypeBox
host packages are peers; explicit development pins are separate. Tests and
synthetic fixtures do not ship. Packed-loader tests use disposable projects and
prove discovery, direct operations, missing-backend behavior, and worker
resolution without Telegram, observability, or private source checkouts.

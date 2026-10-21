# Standalone setup

Use a trusted POSIX project and Node 24.14.1 or later. The test host is Pi
0.87.1; other Pi versions need their own loader/lifecycle validation. The direct
service does not need qmd, Telegram, or observability.

## Direct Markdown store

Inside the intended project, create a note directory and protected configuration:

```bash
mkdir -p notes .pi/markdown-datastore
chmod 700 .pi/markdown-datastore
```

Write `.pi/markdown-datastore/config.json` with generic store identities:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "maxResultBytes": 12288,
    "maxResultLines": 300,
    "operationTimeoutMs": 10000
  },
  "qmd": {
    "enabled": false,
    "installation": { "executable": "qmd" },
    "minimumVersion": "2.8.3"
  },
  "stores": {
    "notes": {
      "root": "notes",
      "include": ["**/*.md"],
      "exclude": [".git/**", ".pi/**"],
      "maxFileBytes": 1048576,
      "search": { "defaultMode": "lexical", "qmdCollection": "notes" }
    }
  }
}
```

Then `chmod 600 .pi/markdown-datastore/config.json`. The config and authority
parents must be current-user-owned, regular directories/files with the existing
safe-mode contract. Root directories must exist; relative roots resolve against
this project, and deliberately configured absolute roots are allowed. Store names,
canonical roots, and qmd collections must be unique. Unknown/duplicate config
keys are rejected. Roots must name real directories without symlink aliases,
including in their ancestry. Descendant symlinks and hard-linked notes are not
accepted by direct reads. The extension does not move, copy, unlink, chmod, or
repair operator data. Enabling qmd currently requires exactly one include pattern.
The normal pattern is `**/*.md`; include/exclude patterns select scanning/indexing,
not direct access. Otherwise valid excluded Markdown remains accessible to exact
find/read within the root.

Build the candidate with `npm ci && npm run build` and start Pi with
`-e /path/to/pi-markdown-datastore/dist/index.js`. Load it once. Status should
report ready direct capabilities, unavailable optional backends, and unsupported
mutations. Try an exact-path find and a bounded read of a synthetic note before
using a real collection. All five tools remain registered with missing/invalid
configuration or an untrusted project. Calls report the specific configuration
failure or `PROJECT_UNTRUSTED`; check the persistent UI status too. Correct the
configuration or project trust and start a new session to load it. No backend or
derived state is started from missing/invalid or untrusted configuration.

## Optional qmd 2.8.3

Install `@tobilu/qmd` 2.8.3 in a separately managed location and prepare its local
models deliberately. The adapter accepts this exact qualified release;
`minimumVersion` is an additional floor, not permission to load other releases.
Configure exactly one installation selector:

```json
"installation": { "packageRoot": "/absolute/path/to/qmd" }
```

Alternatively use `"installation": { "executable": "qmd" }`. Discovery resolves
the launcher once and binds the package's public SDK export. Runtime operations
use that captured installation. Set `qmd.enabled` to `true` after preparation.

Workers use explicit project-local index paths and inline collection configuration.
They inherit only local identity/locale settings and the supported runtime controls
`XDG_CACHE_HOME`, `QMD_EMBED_MODEL`, `QMD_LLAMA_GPU`, `QMD_FORCE_CPU`, and
`QMD_EMBED_PARALLELISM`. Use an absolute local GGUF path for `QMD_EMBED_MODEL`
when selecting an already prepared model. Keep qmd's default expansion/reranker
models prepared in its model cache for hybrid searches. Credential variables,
Node injection options and global collection configuration are not inherited.

Omitting `datastore_refresh` mode selects `direct`, which only revalidates
captured root identities: no note scan or index update. It returns its bounded
root-check result. `lexical` queues update and schedules semantic batching after
success. `semantic` queues update plus embedding; `all` uses that same path.
Lexical/semantic/all starts return a durable `refreshId` before completion.
Poll `datastore_status` for completion and use
`{ "action": "cancel", "refreshId": "..." }` to cancel a job. Explicit lexical
refresh runs immediately through the serialized maintenance queue. Startup
reconciles lexical state asynchronously. A fixed five-minute batch performs
semantic work after lexical refresh; clean ticks do no work. Publication batching
of lexical updates is not implemented: integrations must continue requesting
explicit lexical refresh when needed. External filesystem edits require refresh.

During coordinator-owned semantic maintenance, lexical reads use a separate
process. Hybrid requests return lexical results with `SEMANTIC_UNAVAILABLE`
warning and `requestedMode`/`effectiveMode`; semantic-only requests fail with
retryable `SEMANTIC_UNAVAILABLE` (embedding underway; try again later). Strict
freshness still rejects unreconciled state. Run maintenance through this
coordinator; independently launched writers are not tracked.

Derived state resides below `.pi/markdown-datastore/state/`, in a directory
specific to the qmd release and configured source identities. Directory/file
permissions are 0700/0600. Use qmd to build these indexes from source, rather than
copying a global index. Search failure does not prevent direct reads. Native
embedding has qmd's SDK session cap; native update/embed worker requests also
have a 35-minute deadline excluding prior maintenance queueing and metadata
scanning. Before update, preflight checks selected-file filesystem metadata,
containment/types/links, per-file sizes and aggregate document/byte limits. It
does not open and decode every note; later content reads and result validation
are separate. Partial or failed jobs remain observable and require an
explicit retry. Do not assume that an interrupted refresh preserves an unchanged
previous index.

## Integration and troubleshooting

Use `/client`'s synchronous capability query at `resources_discover`, after all
`session_start` handlers. Version/contract 1 and `ready: true` mean a configured
service; require your configured store name too. Backend capability/index
readiness comes from `status`. Absence is prompt; do not probe it by waiting on
an ordinary operation timeout. Clear capabilities across shutdown/reload.

Policy consumers additionally require `policyVersion: 1` and pass the discovered
`capability` to `createMarkdownDatastoreClient`. `roots({})` enumerates canonical
unredacted effective roots; `validateDestination({ path })` reports ownership of
the actual absolute destination, including nonexistent suffixes. Reject owned
writes and fail closed on errors. A file beside a store is not owned merely
because its parent contains that store. Recheck at publication; policy is not a
write grant or reservation. See [the API contract](design.md#public-root-and-destination-policy).

Timeout scopes are separate: service operations have a 15-minute ceiling;
`operationTimeoutMs` bounds dispatched qmd reader requests, excluding queue wait.
The cross-extension client defaults to 15 minutes and allows overrides in its
existing 1-900000 ms range. The maintenance-worker deadline above applies to the
background native request, not a refresh receipt waiter. Cancelling a waiter does
not cancel the shared job; use explicit refresh cancellation for that.

`STORE_UNKNOWN` means the name is outside this configuration. `PATH_ESCAPE`,
`SYMLINK_REJECTED`, or identity errors require fixing the caller/reference or
reviewing the intended configuration, not relaxing containment.
`STALE_CONTINUATION` means the note changed; start a new read. `STALE_INDEX` is
explicit freshness rejection. Timeouts/cancellations stop owned backend work;
do not increase budgets to conceal stalled progress. Optional backend failures
must never make derived data authoritative or disable valid direct reads.

Development commands and opt-in qmd/packed-host checks are in the README.
The package's tarball includes its runtime worker but excludes all test fixtures,
private operational material, and source checkout state.

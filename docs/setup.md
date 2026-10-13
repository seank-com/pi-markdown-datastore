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
keys are rejected. Enabling qmd currently requires exactly one include pattern.

Build the candidate with `npm ci && npm run build` and start Pi with
`-e /path/to/pi-markdown-datastore/dist/index.js`. Load it once. Status should
report ready direct capabilities, unavailable optional backends, and unsupported
mutations. Try an exact-path find and a bounded read of a synthetic note before
using a real collection. Missing/invalid configuration or untrusted projects
register no datastore tools; check the persistent UI status for the error code.

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

`datastore_refresh` lexical/semantic/all starts return a durable `refreshId`.
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
embedding has qmd's SDK session cap; the parent also enforces a 35-minute
maintenance deadline. Partial or failed jobs remain observable and require an
explicit retry. Do not assume that an interrupted refresh preserves an unchanged
previous index.

## Integration and troubleshooting

Use `/client`'s synchronous capability query at `resources_discover`, after all
`session_start` handlers. Version/contract 1 and `ready: true` mean a configured
service; require your configured store name too. Backend capability/index
readiness comes from `status`. Absence is prompt; do not probe it by waiting on
an ordinary operation timeout. Clear capabilities across shutdown/reload.

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

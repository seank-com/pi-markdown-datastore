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
this project, and deliberately configured absolute roots are allowed. Store aliases
must be unique. Private roots and qmd collections are unique within their
project-owned backend; shared canonical definitions use independent namespaces. Unknown/duplicate config
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
using a real collection. All six tools remain registered with missing/invalid
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
explicit lexical refresh when needed. The common five-minute reconciliation also discovers external filesystem edits; request an explicit refresh when they must be visible sooner.

`datastore_refresh` mode `metadata` updates the wikilink and frontmatter-tag index without qmd. Optional `paths` names the changed relative files; without them, or with mode `rebuild`, the index is rebuilt from source and ignores stored timestamps. A five-minute reconciliation on the common coordinator stats the store and updates changed paths before any lexical job. It runs for private and shared owners even when qmd is disabled. Publishing metadata does not mark qmd current.  `datastore_status` reports that index's readiness, revision, completeness, and job progress even when qmd is disabled or unavailable. `datastore_tags` lists tag identity, display spelling, and distinct page count. `datastore_read` views `links` and `backlinks` read that index. An attachment backlink is inspected, not opened as Markdown. A continuation on those results is bound to the store, revision, and query, and uses the same read budget check as the first page.

## Shared catalog

A shared store is opt-in. Write an absolute catalog the operator owns, then reference it from a project store. The catalog's `socketPath`, `stateRoot` and source roots are absolute. The socket parent must be an owner-only directory; the catalog must be a protected current-user-owned file. Its `defaults` and `qmd` fields are the same reader and backend settings a private store already uses, not transport limits.

For example, a catalog can use this shape. The numeric settings repeat the private-store example above; they illustrate existing configuration and do not establish approval or new defaults:

```json
{
  "schemaVersion": 1,
  "socketPath": "/example/run/markdown.sock",
  "stateRoot": "/example/state/shared",
  "defaults": {
    "maxResultBytes": 12288,
    "maxResultLines": 300,
    "operationTimeoutMs": 10000
  },
  "qmd": {
    "enabled": true,
    "installation": { "packageRoot": "/example/qualified-qmd" },
    "minimumVersion": "2.8.3"
  },
  "stores": {
    "notebook": {
      "root": "/example/notebook",
      "include": ["**/*.md"],
      "exclude": [".git/**", ".pi/**"],
      "maxFileBytes": 1048576,
      "search": { "defaultMode": "lexical", "qmdCollection": "notes" }
    }
  }
}
```

The source root and the state/socket parents must exist. The host creates and validates its protected state directory without changing source permissions. Keep socket paths within the operating system's native Unix-socket support; an OS path error is not permission to move source files or invent a new application length policy.

### Manual foreground check

The service runs in the foreground; an operator or service manager owns that process. The foreground entry uses Node and this package's production dependencies, without requiring Pi/TypeBox peers or the Pi extension loader. The hosted Pi extension still uses its host's peers and project configuration directory. For a manual check after building:

```bash
node dist/shared-service-main.js --catalog /absolute/catalog.json
```

Do not run a manual instance alongside a managed instance for the same index. `SIGINT` or `SIGTERM` requests graceful worker shutdown and ownership release.

### macOS startup at login

Configure one operator-managed user LaunchAgent for the shared catalog, not one per connected project. It starts when its OS account logs in, remains running with zero connected clients, and stops independently of client connections. After reboot, a user LaunchAgent requires that login; it is not a pre-login system daemon.

Use a reviewed installed package and an absolute Node 24.14.1-or-later executable, not a mutable development checkout or a shell-only `nvm` command. Create the log directory and save the following as `~/Library/LaunchAgents/com.example.markdown-datastore.plist`, replacing every example path:

```bash
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/markdown-datastore"
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.markdown-datastore</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/installed/pi-markdown-datastore/dist/shared-service-main.js</string>
    <string>--catalog</string>
    <string>/absolute/catalog.json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/example/Library/Logs/markdown-datastore/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/example/Library/Logs/markdown-datastore/stderr.log</string>
</dict>
</plist>
```

Launchd does not expand `~`, `$HOME`, or shell commands inside `ProgramArguments` or log paths, and it does not load shell startup files. Keep catalog, state and socket paths absolute. An absolute qmd `packageRoot` avoids executable discovery through a shell-specific `PATH`; configure any needed supported model/cache environment explicitly. The catalog and source safety checks above still apply.

This example uses `RunAtLoad` for login startup. It deliberately does not select a `KeepAlive` crash-retry policy or add a custom termination deadline. If the service exits, inspect the error and restart it deliberately; startup at login is not a health guarantee.

The following commands change the account's running service. Run them only after deployment is authorized, not as part of checking this example:

```bash
plist="$HOME/Library/LaunchAgents/com.example.markdown-datastore.plist"
domain="gui/$(id -u)"
job="$domain/com.example.markdown-datastore"

plutil -lint "$plist"
launchctl bootstrap "$domain" "$plist"
launchctl print "$job"
```

`bootstrap` registers the job and `RunAtLoad` starts it now; retaining the plist in `~/Library/LaunchAgents` provides startup at later logins. Inspect the reported PID/state/last exit status, the configured logs, and `datastore_status` from an attached project. If the job is registered but stopped after a fault is repaired, `launchctl kickstart "$job"` starts it without forcing replacement of a running process.

For an authorized stop or package/catalog update, use `launchctl bootout "$job"` first and verify the process has exited. Update only the intended installed package/plist/catalog, lint the plist, then bootstrap again. Roll back to the previous reviewed package and plist if needed while preserving source, the catalog's state root and job history. Do not also launch a foreground copy, delete live ownership records, or treat a shared-service update as permission to restart a client's Pi process.

### Project attachments

Project sessions do not install, start, stop, or own the LaunchAgent. First connection does not launch the service; last disconnection does not stop it. A project store that should use it contains only the reference:

```json
"notes": { "shared": { "catalog": "/absolute/catalog.json", "store": "notebook" } }
```

The local name may differ from the catalog id. Search and refresh fail while the service is down. Direct find and read still use the catalog's source root. Stopping the project does not stop the service. Reusing a native collection name in an independent index is allowed; a local alias does not allocate another index. Deliberately configuring a separate private store over the same source folder creates an independent index, not a private cache of the shared one; projects referencing the same canonical catalog entry share its index.

A second host cannot claim an already-owned index by selecting a different socket or catalog path. On graceful shutdown, the common maintenance unit closes its workers and releases ownership. After a crash, the operator may run the same foreground command again: proven-dead owner/worker records are reclaimed, interrupted receipts are recovered and reconciliation runs. No manual dead-lock-file deletion or ownership lease timer is required; login startup is the operator's LaunchAgent responsibility, not a client attachment behavior. If a recorded process is still live or cannot be verified dead, startup reports unavailable; inspect ownership rather than deleting its records or automatically killing that process.

Catalog and project definitions are loaded at startup, not hot-reloaded. Deliberate definition changes require reloading the corresponding host/project; changed source-root identities invalidate old attachments rather than silently redirecting them.

During coordinator-owned semantic maintenance, lexical reads use a separate
process. Hybrid requests return lexical results with `SEMANTIC_UNAVAILABLE`
warning and `requestedMode`/`effectiveMode`; semantic-only requests fail with
retryable `SEMANTIC_UNAVAILABLE` (embedding underway; try again later). Strict
freshness still rejects unreconciled state. Run maintenance through this
coordinator; independently launched writers are not tracked.

Private derived state resides below `.pi/markdown-datastore/state/`; shared state uses the catalog's `stateRoot`. The common ledger and metadata JSON stay at the application state root. Qmd's opaque child directory is specific to its release and configured source identities. Directory/file
permissions are 0700/0600. Use qmd to build these indexes from source, rather than
copying a global index. Search failure does not prevent direct reads. Native
embedding has qmd's SDK session cap; native update/embed worker requests also
have a 35-minute deadline excluding prior maintenance queueing and metadata
scanning. Before update, preflight checks selected-file filesystem metadata,
containment/types/links, per-file sizes and aggregate document/byte limits. It
does not open and decode every note; later content reads and result validation
are separate. Failed receipts remain observable. The common cycle keeps due lexical reconciliation separate from graph currency; failed embedding jobs are not replayed automatically and require an explicit retry. Do not assume that an interrupted refresh preserves an unchanged previous index.

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

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

Write `.pi/markdown-datastore/config.json` with generic store identities. Omit `maxResultBytes` and `maxResultLines` for unbounded results. An explicit positive finite value is optional and is honored as a default, not a hidden ceiling:

```json
{
  "schemaVersion": 1,
  "defaults": {
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
safe-mode contract. Relative roots resolve against
this project, and deliberately configured absolute roots are allowed. A missing or
unreachable root leaves only that store unavailable; healthy stores still load.
The next operation retries full validation without a Pi reload. A returning root
must match its previously committed identity, if any; a replacement is not silently
adopted. A shared client's first observation is committed by a successful direct
read/find, direct root refresh, complete policy result, or shared-host handshake.
Failed first attachment can discard an unused provisional observation; it cannot
replace an identity already used successfully, including direct use while the
shared service is down. Store aliases
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

## Shared declarations

A declaration-managed host uses protected, current-user-owned `host.json` in
`~/.pi/markdown-datastore` (owner-only directory). Choose explicit absolute socket
and state paths; use the same `defaults` and `qmd` objects shown in the legacy
example below, and replace its `stores` object with a `reader` object containing
`maxFileBytes` and `defaultMode`. These are host settings, not per-client
requirements. Start the operator-managed host with:

```sh
node dist/shared-service-main.js --host-config "$HOME/.pi/markdown-datastore/host.json"
```

In a trusted project's `.pi/markdown-datastore/config.json`:

```json
{
  "schemaVersion": 1,
  "stores": {
    "notes": { "shared": { "root": "/example/notebook", "include": ["**/*.md"], "exclude": [] } }
  }
}
```

`notes` is a tool alias, unique among this project's `stores` keys. Another
project can use `reference` for `/example/notebook`, or use `notes` for a
separate root such as `/example/manuals`. Neither alias chooses a qmd collection
name. The separate physical indexes for those roots can each use a collection
named `notes`.

`include` and `exclude` can be omitted for the values shown; shared definitions
use one include pattern. Same-root registrations require the same effective
arrays, including order and spelling. Use real absolute paths; nesting and
filesystem aliases are rejected. A trailing directory separator is accepted.
Shared-only projects need no QMD installation settings. Mixed projects keep
their existing private settings. The first indexed operation attaches and
registers as needed; it does not start the host. Direct reads need no host process.

Back up source Markdown, complete project declarations and host settings. The
host writes protected `registrations.json` beside `host.json` for unattended
restart with zero clients. It has no project-directory references and can be
recreated on normal attachment, so a fresh host without that file starts empty.
Keep it if unattended reconstruction is needed before clients attach. An
unreadable or invalid snapshot is a configuration error, not a fresh start.
A missing source leaves its registration reserved and does not stop other
stores. Native indexes and metadata snapshots can be rebuilt. Historical job
receipts cannot be derived from Markdown; keep their ledgers if history or
unfinished work must survive. Do not remove them to fix a registration failure.

The foreground and login lifecycle below also applies to declarations; use
`--host-config` and the absolute host config path in the LaunchAgent. Changing
host settings or activating a service remains an operator action.

## Legacy shared catalog

The existing reference-only format is retained for the rollout to the three
current clients and will be removed as part of this work after all three migrate.
Until cutover, `--catalog` uses the existing state locations, ownership, and
queue provenance. The current service runs in one mode at a time and does not
support mixed reference-only and declaration clients on one host. Declaration
mode does not import old IDs, state directories or ledgers. Do not run both
modes over the same store or change client config alone: the migration procedure
uses a terminal-only conversion, not receipt adoption.

### Staged conversion for the three current clients

1. Stage each new client package separately with its old project config and the
   existing `--catalog` host. Verify shared search after each package move. Do
   not change config formats during this stage.
2. In a separately authorized common window, let maintenance finish, then stop
   the old service and keep it stopped. Shared indexed operations will be down
   during conversion; direct operations do not depend on the shared socket.
3. With the host stopped, prepare an inert bundle outside logs and choose an
   unused, explicit derived-state directory:

   ```sh
   node dist/shared-cutover-main.js /example/catalog.json /example/recovery/cutover /example/new-state
   ```

   The command refuses unfinished receipts (including work requeued at stop),
   unverifiable definitions or ledgers, uncertain or active owners, and existing
   output paths. It checks catalog members under their existing ownership leases.
   It does not cancel jobs or modify source, input configs or ledger bytes.
   A completed bundle has `report.json`, exact catalog and ledger copies with
   ledger hashes and binding context, and candidate `host.json` and
   `registrations.json`. Keep this bundle as history, not as a live queue.
4. Review the candidates and retain the old service and project configs for
   rollback. Install the host candidates in the protected host directory, and
   replace each old `shared` reference with the corresponding complete
   declaration from `report.json`, keeping its alias and all unrelated private
   settings. Start only the declaration host and activate the new project configs
   sequentially. Its new derived state is rebuilt from Markdown. The old receipts
   are not visible in its new active ledger.
5. Before new admissions, rollback can stop the candidate and restore the old
   host and project configs with their original state. Once the new host has
   admitted work (including startup reconciliation), this is no longer a
   state-preserving rollback: preserve the new state and obtain a separate
   disposition for that work. Never copy a new ledger into an old namespace.
   Remove the old config format, host mode, and temporary preparation command
   after all three actual clients have migrated and been accepted.

A shared store is opt-in. Write an absolute catalog the operator owns, then reference it from a project store. The catalog's `socketPath`, `stateRoot` and source roots are absolute. The socket parent must be an owner-only directory; the catalog must be a protected current-user-owned file. Its `defaults` and `qmd` fields are the same reader and backend settings a private store already uses, not transport limits.

For example, a catalog can use this shape. The numeric settings repeat the private-store example above; they illustrate existing configuration and do not establish approval or new defaults:

```json
{
  "schemaVersion": 1,
  "socketPath": "/example/run/markdown.sock",
  "stateRoot": "/example/state/shared",
  "defaults": {
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

The state/socket parents must be available. An unavailable source root leaves
that member unbound; the host serves healthy members and admits the returning
member on its next request. The host creates and validates its protected state directory without changing source permissions. Keep socket paths within the operating system's native Unix-socket support; an OS path error is not permission to move source files or invent a new application length policy.

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

Catalog and project definitions are parsed once, not hot-reloaded. An initially
unreachable catalog is first parsed when a referenced store is requested after it
returns. Bad schema, unsafe permissions and unsafe root aliases remain structural
errors, not reasons to bypass validation. Deliberate definition changes require
reloading the corresponding host/project; changed source-root identities invalidate
old attachments rather than silently redirecting them.

Use `datastore_status` to distinguish source-root unavailability from shared-service
or backend failure. Status reports unavailable capabilities per store. Unscoped
refresh processes available stores with warnings for unavailable members; a scoped
refresh fails for its unavailable store. Root/destination policy still fails if any
configured store cannot be validated. Restoring a source root does not restart a
dead shared service; that remains an explicitly authorized operator action.

During coordinator-owned semantic maintenance, lexical reads use a separate
process. Hybrid requests return lexical results with `SEMANTIC_UNAVAILABLE`
warning and `requestedMode`/`effectiveMode`; semantic-only requests fail with
retryable `SEMANTIC_UNAVAILABLE` (embedding underway; try again later). Strict
freshness still rejects unreconciled state. Run maintenance through this
coordinator; independently launched writers are not tracked.

Private derived state resides below `.pi/markdown-datastore/state/`; shared state uses the catalog's `stateRoot`. The common ledger and metadata JSON stay at the application state root. Qmd's opaque child directory is specific to its release and configured source identities.
Each private store has an independent backend binding beneath the same application
state root. Older combined private qmd directories are left untouched; the separate
bindings require source reindexing. The common ledger and metadata paths do not move.
If the stable ledger is absent and historical jobs need an initially unavailable
private source identity for provenance, maintenance waits rather than adopting
with a partial fingerprint or replacing history. Healthy direct reads and status
remain usable. Restore the source and request that store again so strict adoption
can complete; historical files stay unchanged. Directory/file
permissions are 0700/0600. Use qmd to build these indexes from source, rather than
copying a global index. Search failure does not prevent direct reads. Native
embedding has qmd's SDK session cap; native update/embed worker requests also
have a 35-minute deadline excluding prior maintenance queueing and metadata
scanning. Before update, preflight checks selected-file filesystem metadata,
containment/types/links, per-file sizes and aggregate document/byte limits. It
does not open and decode every note; later content reads and result validation
are separate. Failed receipts remain observable. The common cycle keeps due lexical reconciliation separate from graph currency; failed embedding jobs are not replayed automatically and require an explicit retry. Do not assume that an interrupted refresh preserves an unchanged previous index.

## Terminal legacy maintenance history

If startup cannot prove which versioned application ledger belongs to the current
configuration, do not delete its state or guess an adoption source. Inspect the
application state with the packaged, peer-independent operator command:

```sh
node node_modules/@seank/pi-markdown-datastore/dist/maintenance-migration-main.js \
  --state-root /absolute/project/.pi/markdown-datastore/state
```

Inspection changes no live state. It reports existing stable state, historical
application ledger hashes/counts, unfinished work and ownership. For terminal-only
history, obtain the required runtime stop/recovery authorization and stop the
consuming project before explicitly initializing a fresh active queue:

```sh
node node_modules/@seank/pi-markdown-datastore/dist/maintenance-migration-main.js \
  --state-root /absolute/project/.pi/markdown-datastore/state \
  --initialize-terminal-history
```

Retain both JSON reports as deployment evidence. All historical receipt files
stay unchanged; the new stable queue contains no replayed work. Existing stable
state is never overwritten. Unfinished work, live/uncertain ownership, malformed
history or an inventory change refuses the operation. Resolve that specific
condition rather than deleting receipts, retrying blindly or rebuilding native
storage. Start the project only through its separately authorized lifecycle and
verify its real private/shared tool path before accepting the deployment.

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

# Standalone setup

Use a trusted POSIX project and Node 24.14.1 or later. The test host is Pi
0.87.1; other Pi versions need their own loader/lifecycle validation. Direct
operations do not need qmd, Telegram, or observability.

## Private Markdown store

Create a note directory and protected project configuration:

```sh
mkdir -p notes .pi/markdown-datastore
chmod 700 .pi/markdown-datastore
```

Write `.pi/markdown-datastore/config.json`:

```json
{
  "schemaVersion": 1,
  "defaults": { "operationTimeoutMs": 30000 },
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

Run `chmod 600 .pi/markdown-datastore/config.json`. Config files and authority
parents must be current-user-owned and satisfy the protected-file checks.
Relative private roots resolve against the project; deliberately configured
absolute roots are allowed. Store aliases must be unique. Private roots and
qmd collections are unique within their project-owned backend.

Omit `defaults.maxResultBytes` and `defaults.maxResultLines` for unbounded
results. Optional positive finite values supply defaults; caller budgets override
them. An honest result that cannot fit reports `RESULT_LIMIT_EXCEEDED`, rather
than dropping fields or increasing the caller's budget. Example numeric values
are configuration examples, not new deployment policy.

Roots must name real directories without symlink aliases in their ancestry.
Direct reads reject descendant symlinks, hard-linked notes and unsafe paths. An
unavailable root disables only its store; the next operation retries validation
without reloading Pi. A committed identity is not replaced silently. Source
permissions and bytes are never repaired. Include/exclude arrays select scanning
and indexing, not direct access: exact reads can still access valid excluded
Markdown inside the root. Enabling qmd requires exactly one include pattern.

Build with `npm ci && npm run build`, then start Pi with
`-e /path/to/pi-markdown-datastore/dist/index.js`. Load this entry once. All tools
remain visible with invalid configuration or an untrusted project; calls report
the configuration failure or `PROJECT_UNTRUSTED`. Correct configuration/trust
and start a new session to load it. No backend starts for invalid or untrusted
configuration. Test exact lookup and a direct read of a synthetic note first.

## Optional qmd 2.8.3

Install `@tobilu/qmd` 2.8.3 separately and prepare its local models deliberately.
This is the exact qualified release; `minimumVersion` is an additional floor,
not permission to load other releases. Choose exactly one installation selector:

```json
"installation": { "packageRoot": "/absolute/path/to/qmd" }
```

Alternatively use `"installation": { "executable": "qmd" }`. Discovery resolves
the launcher once and captures its public SDK binding. Set `qmd.enabled` to
`true` after preparation.

Workers use explicit index paths and inline collection configuration. Supported
runtime controls are `XDG_CACHE_HOME`, `QMD_EMBED_MODEL`, `QMD_LLAMA_GPU`,
`QMD_FORCE_CPU`, and `QMD_EMBED_PARALLELISM`, alongside local identity/locale
settings. Use an absolute prepared GGUF path for `QMD_EMBED_MODEL`; keep qmd's
default expansion/reranker models prepared for hybrid search. Credentials, Node
injection options and global collection configuration are not inherited.

## Shared Markdown stores

The operator supplies protected `~/.pi/markdown-datastore/host.json` in an
owner-only directory. Use absolute canonical state and socket paths with available
parents; the socket parent is owner-only. For example:

```json
{
  "schemaVersion": 1,
  "socketPath": "/Users/example/.local/run/markdown-datastore/host.sock",
  "stateRoot": "/Users/example/.local/state/markdown-datastore",
  "defaults": { "operationTimeoutMs": 30000 },
  "qmd": {
    "enabled": false,
    "installation": { "executable": "qmd" },
    "minimumVersion": "2.8.3"
  },
  "reader": { "maxFileBytes": 1048576, "defaultMode": "lexical" }
}
```

Replace every example path. Use mode 0700 for the host directory and socket
parent, and 0600 for `host.json`. Enable/configure qmd as above when indexed
search is needed; `qmd.enabled: false` still supports shared graph/tag metadata.
The host creates its protected state directory without changing source permissions.
Keep the socket path within the operating system's Unix-socket support; an OS
path error is not permission to move source files or invent a new path limit.

Each trusted project supplies complete declarations in its own config:

```json
{
  "schemaVersion": 1,
  "stores": {
    "notes": {
      "shared": {
        "root": "/example/notebook",
        "include": ["**/*.md"],
        "exclude": [".git/**", ".pi/**"]
      }
    }
  }
}
```

Shared-only projects inherit host defaults when project defaults are omitted
and need no project-local qmd installation settings. Mixed projects retain their
private settings. The protected host settings must be
readable when loading a declaration; direct access does not need the host
process to be running.

`notes` is a local tool alias, not an index or collection name. Another project
can call the same root `reference`, or use `notes` for a different root. The
canonical absolute source path identifies the shared registration. Matching
attachments require identical effective include/exclude arrays, including order
and spelling; omitted arrays default to `["**/*.md"]` and `[]`. Shared roots
cannot contain one another. One include pattern is supported. A trailing root
separator is accepted; filesystem aliases are not. Independent indexes can each
use the same native qmd collection name.

The first indexed operation registers and attaches as needed; it does not launch
the host. Exact-path/URI lookup, content/section/outline reads and root policy
stay in the project; graph and tag operations use the host. A first
source observation remains provisional until successful direct/policy use or a
host handshake; rejected attachment cannot replace an already committed identity.

### Registration and recovery

The host writes protected `registrations.json` beside `host.json`. This snapshot
contains accepted roots and effective patterns, not client/project paths. It
reconstructs known stores and runs maintenance with zero connected clients. With
no snapshot the host starts empty; ordinary complete declarations reconstruct
registrations as clients attach. An invalid or unreadable snapshot is an error,
not an empty configuration. An unavailable source retains its reservation while
healthy stores continue; returning sources are checked on demand. A committed
replacement identity requires an explicit configuration/session change.

Back up source Markdown, host settings and complete project declarations. Retain
the registration snapshot when unattended reconstruction before client attachment
is needed. Derived indexes and metadata can be rebuilt. Historical receipts and
unfinished work cannot be recovered from Markdown: preserve their ledgers when
history or admitted work must survive. Never delete them to repair registration.

### Foreground service

After building, start the operator-managed foreground service:

```sh
node dist/shared-service-main.js --host-config "$HOME/.pi/markdown-datastore/host.json"
```

It needs only this package's production dependencies, not Pi/TypeBox peers or the
extension loader. `SIGINT` and `SIGTERM` request graceful worker shutdown and
ownership release. Do not run a second instance against an owned index, even
with a different socket or host config.

### macOS startup at login

Install one operator-managed user LaunchAgent for the host, not one per project.
It starts at account login, including login after reboot, not before login.
Use a reviewed installed package and absolute Node executable, not a development
checkout or shell-only `nvm` command. Create the log directory and save
`~/Library/LaunchAgents/com.example.markdown-datastore.plist`, replacing all paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.markdown-datastore</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/installed/pi-markdown-datastore/dist/shared-service-main.js</string>
    <string>--host-config</string>
    <string>/Users/example/.pi/markdown-datastore/host.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/example/Library/Logs/markdown-datastore/stdout.log</string>
  <key>StandardErrorPath</key><string>/Users/example/Library/Logs/markdown-datastore/stderr.log</string>
</dict>
</plist>
```

Launchd does not expand `~`, `$HOME`, or shell commands or load shell startup
files. An absolute qmd `packageRoot` avoids shell-specific discovery; configure
supported model/cache environment explicitly. This example chooses neither a
`KeepAlive` retry policy nor a custom termination deadline. Inspect an exit and
restart deliberately.

The following are lifecycle actions, not configuration-validation commands; use
them only with deployment authorization:

```sh
plist="$HOME/Library/LaunchAgents/com.example.markdown-datastore.plist"
domain="gui/$(id -u)"
job="$domain/com.example.markdown-datastore"
plutil -lint "$plist"
launchctl bootstrap "$domain" "$plist"
launchctl print "$job"
```

Inspect the real PID/state, configured logs and an attached project's status.
For an authorized stop/update, `launchctl bootout "$job"` first and prove the
process/workers exited. Update only the reviewed package, host settings or plist,
lint, and bootstrap once. Preserve source, registration snapshot, state and job
history. Restarting a shared service does not authorize restarting a client Pi.

Projects do not install, own or control this service. First attachment does not
start it and last disconnection does not stop it. An unavailable service disables
shared indexed operations, not valid direct reads. A project closing its own
waiters does not cancel accepted shared maintenance. Definitions load once;
deliberate definition changes require the corresponding host/project reload.
After a crash, an operator-started replacement reclaims proven-dead ownership,
reconciles interrupted work and creates a new live generation. Live/uncertain
owners or surviving workers refuse admission; do not delete records or kill a
process to bypass it. Old-generation requests fail rather than retargeting.

## Maintenance and history

Omitted `datastore_refresh` mode is `direct`: root validation only, no scan or
index update. `lexical` queues qmd update and schedules semantic batching after
success; `semantic` and `all` queue update plus embedding. They return durable
receipts before completion. Poll `datastore_status`; explicit cancellation uses
`{ "action": "cancel", "refreshId": "..." }` and does not undo newer work.

`metadata` updates graph/tags without qmd. Optional `paths` selects changed
relative paths; no paths, or mode `rebuild`, rebuilds from source. The common
five-minute cycle reconciles filesystem changes, metadata and due lexical work
for private/shared owners. Explicit refresh is needed when changes must appear
sooner. Semantic batching waits five minutes after lexical work; clean ticks do
nothing. Failed embedding needs explicit retry; there is no infinite retry loop.

Lexical reads use a separate process during embedding. Hybrid then reports
lexical fallback with `SEMANTIC_UNAVAILABLE` and requested/effective modes;
semantic-only calls fail promptly. No fallback hides arbitrary backend failures
or incomplete embeddings. Run writers through the owning coordinator.

Private state lives below `.pi/markdown-datastore/state/`; shared state uses the
host's `stateRoot`. Common ledgers and metadata stay at the application root;
opaque qmd bindings are version/configuration-specific. Private per-store
bindings retain the common queue and leave older combined directories untouched.
A missing stable ledger with unresolved historical provenance blocks maintenance,
not healthy direct reads. Restore unavailable sources and request their stores
again to retry strict adoption; do not guess a definition or replace history.
Permissions are 0700/0600. Build indexes from source rather than copying a global
index. Native update/embed has a 35-minute execution deadline; native embedding
also has its SDK session cap. Preflight checks metadata, containment/types/links,
per-file size and aggregate bounds, not complete UTF-8 source contents. Interrupted
work can leave partial native state; an unchanged previous index is not promised.

### Terminal private maintenance history

When startup cannot prove historical application-ledger provenance, inspect with
the packaged, peer-independent command:

```sh
node node_modules/@seank/pi-markdown-datastore/dist/maintenance-migration-main.js \
  --state-root /absolute/project/.pi/markdown-datastore/state
```

Inspection does not change live state. It reports stable state, historical
hashes/counts, unfinished work and ownership. After separately authorized consuming
runtime stop, terminal-only history can initialize an absent active ledger:

```sh
node node_modules/@seank/pi-markdown-datastore/dist/maintenance-migration-main.js \
  --state-root /absolute/project/.pi/markdown-datastore/state \
  --initialize-terminal-history
```

Retain both reports. Historical receipts stay unchanged; no old job is replayed,
rebound or copied into the new queue. Readable existing stable state returns an
inspection report with `initialized: false`, without replacing the file. When
initialization is needed, unfinished work, uncertain/live ownership, malformed
history or inventory change refuses the operation. Do not delete receipts, retry blindly or rebuild native storage to
bypass that refusal. Runtime start and acceptance remain separately authorized.

## Integration and troubleshooting

Use `/client` capability discovery at `resources_discover`, after all
`session_start` handlers. Version/contract 1, `ready: true`, and the required store
alias establish configuration readiness; backend/index readiness comes from
status. Clear references on teardown/reload. Policy clients also require
`policyVersion: 1` and the discovered capability. `roots({})` and
`validateDestination({ path })` expose complete effective containment; reject
owned writes, fail closed on errors and recheck at publication. Policy is an
observation, not a write grant or reservation. See [design](design.md).

Timeouts cover different scopes: reader `operationTimeoutMs` excludes queue wait;
service operations have a 15-minute ceiling; the cross-extension client defaults
to 15 minutes with its 1-900000 ms override range. Maintenance deadlines exclude
queueing and metadata scanning. Cancelling a waiter does not cancel an admitted
job; use explicit refresh cancellation.

`STORE_UNKNOWN` means the alias is outside configuration. Path, symlink or
identity errors require correcting the caller/configuration, not weakening
containment. `STALE_CONTINUATION` requires a new read; `STALE_INDEX` is explicit
freshness rejection. Do not extend budgets to hide stalled progress. Optional
backend failures do not make indexes authoritative or disable valid direct reads.

Development and opt-in native checks are in the README. Packed files exclude
tests, private operational material and source checkout state.

# pi-markdown-datastore
A simple extension for Pi that enables semantic and lexical searching across a folder of markdown files using QMD

Direct content, section and outline reads, exact-path/URI lookup, and status
work on their own. Optional qmd 2.8.3 adds lexical, semantic and hybrid search.
Telegram and observability are not required.

## Local quick start

This `0.1.0` candidate is not published to npm. Use Node 24.14.1 or later on a
POSIX host. Development/CI pins stock Pi 0.87.1; packed-loader acceptance also
tests the accepted patched 0.87.1 artifact. Other hosts require their own loader validation.

```bash
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
npm run test:package
```

Create a project-local configuration as described in [setup](docs/setup.md),
then start Pi with `-e /path/to/pi-markdown-datastore/dist/index.js`. Load this
entry once. It registers `datastore_search`, `datastore_find`, `datastore_read`,
`datastore_status`, and `datastore_refresh` consistently, even without valid
configuration. Missing/invalid configuration or an untrusted project disables
service operation, not tool visibility. Calls report the specific configuration
error or `PROJECT_UNTRUSTED`; fix the configuration/trust and start a new session.
Configured roots must be real directories, not symlink aliases. Descendant
symlinks and hard-linked notes cannot be read; source data is never repaired.

Markdown is authoritative. The extension never edits source notes. Derived
indexes are disposable. Each qmd worker retains its public SDK store and native
cache between requests. Interrupted maintenance can leave a partially updated
index; direct source reads remain available. See [design](docs/design.md).

## Optional integration

`@seank/pi-markdown-datastore/contract` exports the owned v1 types and identifiers.
`/client` exports the typed event-RPC client and a synchronous capability query.
Both helpers can be imported without loading the Pi entry point or installing a
host runtime. Installing the package does not mean its extension is active.

Consumers call `queryMarkdownDatastoreCapability(pi.events)` at
`resources_discover`, after all `session_start` handlers. Check `version`,
`contractVersion`, `ready`, and the required store name. Readiness means the
configured service is available, not that an optional search backend or
index is ready; `status` reports those capabilities separately. Clear references
on teardown/reload. Absence returns immediately, without the operation timeout.

For datastore-owned destination policy, require `policyVersion: 1`, then bind a
client to the discovered capability:

```ts
const capability = queryMarkdownDatastoreCapability(pi.events);
if (!capability?.ready || capability.policyVersion !== 1) throw new Error("Datastore policy unavailable");
const client = createMarkdownDatastoreClient(pi.events, { capability });
const roots = (await client.roots({})).data.roots;
const policy = (await client.validateDestination({ path: absoluteDestination })).data;
if (policy.owned) throw new Error("Destination belongs to a datastore");
```

These supported APIs use the effective configuration and captured root identities,
not consumer-side config parsing. They work without qmd, accept new destinations,
and fail explicitly on unsafe aliases, unavailable roots, or stale instances.
Recheck the actual destination at publication. This is datastore ownership, not a
write grant; other consumer restrictions still apply. See the
[policy contract](docs/design.md#public-root-and-destination-policy).

## Tests

Default tests use synthetic public SDKs and protected disposable projects. They
exercise process supervision, source containment, native-store lifetime, job
state, fallback modes, cancellation, semantic batching and tool/event envelopes.
They do not download models or use global qmd indexes. Packed-loader tests
install the built tarball offline using the npm cache prepared by `npm ci`.

Additional checks are explicit:

```bash
# Real qmd 2.8.3 SDK, still using disposable notes and derived state:
DATASTORE_QMD_PACKAGE=/path/to/qmd npm test

# Only with local models already prepared; may be expensive:
DATASTORE_QMD_PACKAGE=/path/to/qmd DATASTORE_QMD_SEMANTIC_TEST=1 npm test

# Packed-loader acceptance with another explicitly selected host artifact:
PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent npm run test:package
```

To keep private terms and secrets out of commits, run `npm run hooks:install`
once per clone. Commits and pushes are then refused when an added line or a
commit message contains a line of `~/.pii` (one term per line, matched
case-insensitively; `#` lines are comments) or a value of 8 or more characters
from `~/.env`. `PRIVATE_TERMS_FILE` and `PRIVATE_SECRETS_FILE` select other
files. `npm run check:private -- --all` checks every staged file, including
unchanged ones.

Only compiled JS/declarations, the worker asset, generic docs, README, LICENSE,
and package metadata ship. Original public history and extracted-code MIT
attribution are preserved.

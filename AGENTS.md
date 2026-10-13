# Datastore development

Use Node 24.14.1 or later, Bash and TypeScript. Run `npm ci`, `npm run check`,
`npm test`, `npm run build`, `npm pack --dry-run`, and `npm run test:package`.
Default tests use synthetic backends and protected disposable projects, never
real vaults, global indexes, models, or live agent state. Real qmd checks require
an explicit `DATASTORE_QMD_PACKAGE`; semantic checks additionally require
`DATASTORE_QMD_SEMANTIC_TEST=1` and already prepared local models.
Source Markdown stays authoritative. Preserve configured identities, contained
paths, exact backend binding, parent-owned cancellation, and atomic publication.
Document worker count accurately. Keep standalone use independent of Telegram
and observability; integration discovery uses the owned event-bus contract.
Preserve MIT attribution/public history. Do not push, publish, activate live
resources, or change other repositories without owner authorization.

## Dependency boundaries

Integrate dependencies through their supported public APIs and CLI commands.
The CLI is an API; a small adapter may combine SDK calls and CLI invocations.
For qmd, leave storage, caching, model lifecycle, and indexing implementation
to qmd. Do not import private modules, access internal objects, read or mutate
its SQLite schema, copy private algorithms, or patch its runtime to obtain
behavior missing from the public contract. An exported symbol alone does not
establish a supported public contract.

Verify required behavior against the supported interface and version using
disposable integration fixtures. If that interface cannot meet a requirement,
record the evidence and tradeoff in the issue and seek a design decision
instead of silently bypassing the boundary. Existing implementation choices
are open to revision through an approved design; the
preservation guidance above is not a mandate to retain private integrations.

## Documentation and history

Repository documentation describes the current product: its behavior,
interfaces, configuration, dependencies, and operational requirements.
Keep investigation narratives, decision history, rejected approaches, and
implementation progress in issues and commit messages. Do not add review
reports, handoff diaries, or historical design documents to the repository.
Document enduring contracts and rationale only where they help someone use
or maintain the current implementation.

Write about what the product does. When a feature or dependency is removed,
remove its obsolete documentation and references rather than replacing them
with statements that it is no longer supported. Do not inventory unrelated
technologies or absent features. State a limitation only when it affects a
current supported workflow or a concrete user decision; provide actionable
guidance. Put any necessary transition instructions for shipped behavior in
release or migration notes, not permanent descriptions of the product.

Before finishing documentation changes, read them from a new user's
perspective: each statement should explain the current product without
requiring knowledge of the discussion or the previous implementation.

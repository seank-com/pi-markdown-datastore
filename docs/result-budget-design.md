# Unbounded result-size defaults and caller budgets

This contract describes result budgeting and resource ownership. Installation, configuration migration and named runtime activation remain separate operator decisions.

## Purpose and scope

Datastore is local knowledge infrastructure, not a model-context policy engine. It must not choose an arbitrary byte/line ceiling on the caller's behalf. A caller can request less data to manage context. Resource ownership and cleanup are separate responsibilities, not reasons to invent replacement result caps.

Byte/line controls have the same meaning across direct operations, event RPC, shared service, backend framing and model tools. No fixed output or request/result framing ceiling substitutes for an omitted budget. Excerpts select the relevant paragraph rather than impose another byte/line truncation.

It does not change what a query selects: search/find result-count selection, source-file validation, input/query limits, ledger retention, deadlines, worker count, diagnostic-stderr policy and namespace/authority checks remain separate existing policies. They are not approved merely by being outside this change. Keep unresolved approval gaps explicit in the restrictions register. Do not silently turn this into all-corpus search, a transport redesign, a Pi upgrade or new operational limits.

## Public budget contract

- `maxBytes` and `maxLines` are optional caller controls on every result-producing public operation: search, find, read (all views), tags, status, refresh/cancel, roots and destination validation. Apply the same meaning through the public client, shared operations and tools.
- Omitted controls use explicitly configured defaults if present; otherwise that dimension is unbounded. No huge finite replacement constant, hidden helper default or facade-only cap substitutes for omission.
- An explicit caller value is a positive finite safe integer. It overrides a configured default; a configured default is not a maximum. Reject invalid values rather than silently clamp them.
- Configuration keeps accepting existing explicit finite `defaults.maxResultBytes` and `defaults.maxResultLines` without the old maxima; those keys become optional. Other required configuration and existing timeout semantics do not acquire new defaults in this update.
- JSON does not carry `Infinity`. In result bounds, `maxBytes: null` or `maxLines: null` means the corresponding dimension is unbounded. Finite bounds remain numbers. Add an optional discovery field `resultBudgetVersion: 1` to advertise this interpretation and uniform caller controls without renaming the v1 event or replacing existing capabilities.
- A finite byte budget covers the complete serialized result envelope exposed by the API/tool, including metadata, not just the document body. Returned byte counts describe that representation. Line budgets use logical-payload lines (content lines or aggregate snippet lines), counting a final newline as a terminator rather than another empty line; they do not depend on incidental JSON pretty-printing. Test and document the accounting consistently.
- Existing pageable views use their continuation mechanism when a finite budget requires paging. Do not silently omit fields from otherwise nonpageable status, policy or receipt results, or invent a default summary projection to conceal a large result. A finite budget that cannot represent an honest result returns `RESULT_LIMIT_EXCEEDED`, not corrupt/truncated JSON or an unrequested partial authority scope.
- Tiny budgets may be too small even for the minimum envelope. That is a controlled caller-budget error, not a reason to raise the caller's value. The error itself is not a result payload promised to fit an impossible budget.

## Continuations and admitted work

Continuation/section identity, source revisions and query bindings remain intact. Carry optional/unbounded dimensions without encoding JSON infinity. A caller may override the byte/line controls on the next page without changing the token's selection or cursor. Preserve old finite tokens where otherwise valid; a new budget is not permission to retarget the note, index or query.

Output budgeting must not hide committed work. Default unbounded refresh and status must return the full existing data, including large durable path scopes. If an explicit finite response budget is too small, reject before admission where that can be established without changing work. If a refresh/cancellation was already durably applied, the resulting error must say so: retain `RESULT_LIMIT_EXCEEDED` with `details.operationApplied: true` and `details.refreshIds` containing the actual known IDs. Preserve this information across shared/event clients and make it visible in model-facing error text. Never replay, cancel or terminalize work merely because its response did not fit. Test that callers can still observe/cancel the correct admitted job.

## Implementation boundaries

- `contract`, `client` and `index` own uniform budget inputs, nullable unbounded result metadata, additive discovery and truthful tool/error serialization. Keep conditional tool schemas flat object alternatives and preserve read/refresh exclusions; verify actual native-wire payloads, not only TypeScript types.
- `config-common`, `config` and `shared-catalog` resolve/validate optional budgets. `service`, `markdown`, `metadata-index` and `continuations` apply them consistently. No fallback call to a Pi truncation utility may reintroduce its 50 KiB/2,000-line defaults when an operation is unbounded.
- `shared-client`, `shared-host` and `shared-ipc` carry caller controls, full results and applied-work error metadata without a second default ceiling. A client budget must not become the shared catalog's policy for another client. Advertise `resultBudgetVersion: 1` in the shared handshake too: a new client must report an explicit capability gap rather than silently promise unbounded results from an older bounded owner. Older finite clients may continue where their contract is supported. Changing output budgets is not a change to source/index identity and must not itself rebuild or retarget an index.
- `qmd-worker-client` and `qmd-worker.mjs` preserve current framing/version/lifecycle, but do not reject valid request/result frames solely at the old 1 MiB boundary. The separate existing diagnostic-stderr restriction is not a response budget and is not silently changed. No new deadline, retry, frame-size replacement or concurrency gate is introduced.
- Consumers need to accept null bound metadata and deliberately choose finite context budgets when desired. Do not migrate or edit live configuration automatically. An operator-approved rollout must remove inherited finite defaults from the intended live configurations if unbounded defaults are desired there; retaining an explicit old value still deliberately selects it.

## Resource ownership

The component releases ownership of completed request buffers, listeners, timers, abort handlers and pending-map entries on success, cancellation, failure, disconnect and shutdown. Caller-retained results, the current derived metadata snapshot, descriptor-only continuations and intentionally warm workers have legitimate lifetimes; do not label all retained state a leak or evict it speculatively.

In particular, the current worker parser keeps a `Buffer.subarray()` tail after decoding a frame. Even an empty view can retain the full backing allocation while the worker client remains alive. Release drained backing storage and incomplete-frame storage on retirement/close; do not wait for a later request to replace it. Shared parser teardown must also release partial frames and its subscriptions. Do not introduce another long-lived serialized-result cache or keep whole note bodies in continuation descriptors.

Avoid unnecessary repeated concatenation/copying as frames grow, using straightforward existing stream/framing mechanisms. No promise of zero-copy or catchable out-of-memory failure is made. Validate deterministic ownership invariants; repeated memory measurements may be diagnostic, never an invented RSS threshold, GC deadline or host-speed pass gate.

## Qualification

1. Reproduce an oversized status/refresh scope with synthetic paths, then prove the default unbounded local/shared/tool paths return it intact rather than hide it in a summary. Test results above both old 32 KiB/800-line boundaries and backend frames above 1 MiB. These are probe sizes, not new production limits.
2. Exercise optional finite configured defaults and per-call overrides across every operation; check exact serialized byte accounting, logical lines, UTF-8, tiny-budget errors, pagination and changed budgets on continuations. No silent larger-budget clamp.
3. Verify finite refresh/cancel response failures cannot disguise admitted/applied work or alter queue ownership. Policy results never lose roots to fit a budget.
4. Test chunked/multiple large frames, UTF-8 split boundaries, late/invalid replies, close/cancel/failure mid-frame, and normal cleanup. Pending resources settle once; retired buffers/listeners are released and shared jobs survive waiter detach as designed.
5. Preserve source identity, revision-bound results, qmd-independent metadata, shared single-owner/reconnect behavior, standalone peerless CLI startup and raw tool-schema correctness.
6. Run complete affected component/default/package coverage, packed consumer composition, the three private assemblies and the targeted opt-in real-provider schema check before any new activation. No real vault mutation, new credential access or live runtime changes are part of source implementation.

Update the current design/setup/register when implemented, removing obsolete result ceilings rather than describing them as current policy. Record source/artifact identity and remaining unrelated limits honestly. Publication, installation, configuration migration and named runtime activation remain separate owner decisions.

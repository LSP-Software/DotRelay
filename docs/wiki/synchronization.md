# Synchronization, staging, and publication

Authenticated protocol endpoints live under `/api/v1` and combine strict JSON
administration with exact `application/vnd.dotrelay.e2ee-v3+cbor` protected
transport. Authenticated responses use `Cache-Control: no-store`.

Protocol routes are rate limited through disposable Valkey counters in
production. Development skips enforcement when Valkey is unavailable.

## Operation lifecycle

1. **Begin** — `POST /api/v1/operations/:operationId/begin` with a CBOR command
   body, `Idempotency-Key` equal to the operation id,
   `X-DotRelay-Operation-Kind`, and `X-DotRelay-Device-Id`.
2. **Stage** — `PUT /api/v1/operations/:operationId/staging/:objectId` uploads
   immutable lane and Revision objects for the operation.
3. **Finalize** — `POST /api/v1/operations/:operationId/finalize` submits the
   strict JSON publication descriptor and performs compare-and-swap head
   advancement through `PublicationRepository`.
4. **Epoch transition** — `POST /api/v1/operations/:operationId/epoch-transitions`
   finalizes an `EPOCH_ROTATION` operation across every active Environment in a
   Project through `ProjectEpochRepository.rotate`.
5. **Cancel** — `DELETE /api/v1/operations/:operationId` cancels an uncommitted
   staged operation.

Publication and Rollback share the finalize route. The service verifies the
Revision signature with the actor Device's Ed25519 public key before committing.
`stale_head` problems include `headId` and `headHash` for client reconciliation.
`stale_epoch` problems surface when an epoch transition no longer matches the
Project's current epoch.

## Synchronization

`POST /api/v1/environments/:environmentId/sync` accepts strict JSON describing
the client's trusted Revision id and SHA-384 hash plus optional pagination. The
response is a CBOR synchronization page containing exact canonical protocol bytes
for authorized Revisions after the trusted point, ordered oldest-first. Cursor
values bind a Revision id and hash so pagination never skips verification.

Read-side authorization excludes User-defined Value lanes owned by another User
before objects are returned. Sync integrity failures surface as `state_conflict`.

## Related docs

- [Architecture and wire boundaries](./architecture.md)
- [PostgreSQL persistence](./persistence.md)
- [Device trust and key workflows](./trust.md)

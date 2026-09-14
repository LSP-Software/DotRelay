# The Project stores only the Repository Identity

Status: accepted

Descriptive owner/name never enters the Project: the domain store keeps only the Repository
Identity, and the descriptive record of a Repository Linkage lives in the client's worktree
context as an opaque identifier pair (issue #82). Storing names on the Project was rejected
because it adds a schema migration and a rename write path to the security-critical domain
store for a niche edge case (a fresh machine matching with zero GitHub contact); ordinary sync
of an established machine already needs no GitHub contact, and descriptive display remains
best-effort and non-authoritative.

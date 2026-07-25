# Foundation architecture

Code stays in its owning application until a second real consumer exists. Shared packages are
private, use `workspace:*`, and expose only intentional public exports. Database, cache,
authentication, and web UI code remain application-local until actual reuse appears.

The hosted and self-hosted products use the same backend build and protocol. This foundation adds
no product behavior; later tickets own the domain, cryptography, persistence, authentication, web,
CLI, and deployment capabilities.

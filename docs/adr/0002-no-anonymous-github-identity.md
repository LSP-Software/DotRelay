# No anonymous public GitHub API dependency for repository identity

Status: accepted

The CLI resolves a worktree's Repository Identity only through deliberately supported
user-authorized paths, never through an unauthenticated `api.github.com` lookup: private
repositories are invisible to the anonymous API, and one lookup collapses 404s, redirects, rate
limits, and outages into the same `repository_resolution_failed` dead end (issue #82). A Project's
stored Repository Identity, not a live anonymous lookup, identifies its repository, so an
established Repository Linkage stays usable while GitHub is unavailable or rate limited.

# The CLI never calls the GitHub API

Status: accepted

The CLI performs no direct calls to the GitHub API: Repository Resolution happens only in the
service on the acting User's behalf, and even the previously documented `GITHUB_TOKEN` fallback
is removed (issue #82). A user-supplied token in the CLI was rejected because any parallel
identity path reintroduces the ambiguous failures the issue removes and lets a client bypass the
service's access verification; a GitHub outage therefore degrades only first contact and rename
detection, never ordinary sync of an established Repository Linkage.

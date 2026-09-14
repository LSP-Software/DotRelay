# Resolve repository identity through the service on the user's behalf

Status: accepted

The service resolves a repository's Repository Identity and verifies the acting User's access
using the User's Delegated GitHub Access stored at sign-in; the CLI sends only the descriptive
owner/name and never a GitHub token (issue #82). Service-mediated resolution was chosen over a
CLI-held token, which the acceptance bar excludes, and over operator-supplied identifiers, which
cannot detect canonical renames; it also gives one authorized path to distinguish missing access,
renames, rate limits, and outages.

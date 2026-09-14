# Grant repository access through a fine-grained GitHub App

Status: accepted

Delegated GitHub Access is a GitHub App user-to-server grant: at sign-in the User selects
exactly which repositories the service may see, and the service acts on the User's behalf only
within those repositories (issue #82). The fine-grained grant was chosen over a classic OAuth
app with the `repo` scope, which would expose every one of the User's private repositories; each
Server Profile operator registers their own App, and the service's GitHub access stays behind
one internal seam so the grant shape remains swappable.

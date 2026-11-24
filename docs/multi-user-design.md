# Multi-User Design

Status: phase 1 built (0.3.0). Tasks: BOT-185 (design), BOT-203 (visibility
decision), BOT-208, BOT-209, BOT-210.

## Summary

Several people use one botnote instance, each with their own agents. Some
projects are shared, the rest are private. The first real case is a couple:
shared household projects next to each person's own work.

Tenancy (many independent workspaces on one hosted instance, with sign-up and
billing) is a later, commercial-edition concern. Its foundation, isolation by
`workspace_id`, already exists and is unchanged here.

## The model

- A **project** has one owner and a visibility:
  - `private`: the owner and the owner's agents.
  - `shared`: every member of the instance.
- New projects are private. Only the owner changes visibility.
- Content **outside a project** (inbox tasks, loose notes, weekly reviews,
  product feedback) belongs to its author and is never shared. To share a
  note, put it in a shared project.
- An **API token** belongs to the person who created it. An agent using it sees
  exactly what that person sees.
- **Roles** (`owner`, `admin`, `member`) govern the instance, not content:
  inviting and removing people, embedding and timezone settings. No role sees
  another person's private project, the owner included.
- Any member of a shared project can read and write everything in it,
  including the project's name and AGENTS.md.

Rejected alternatives: per-entity permissions and per-project member lists
(too much surface for two to ten people; revisit when a team asks), and
"everything is readable by all members" (an earlier draft; it cannot hold a
couple's private projects).

## Enforcement

Visibility is one SQL predicate, defined once in `src/service/scope.ts`:

- `projectVisible(scope, alias)`
- `entityVisible(scope, alias)`: in a project, follow the project; outside
  one, `author_user_id` must be the caller.
- `entityInScope(scope, alias)`: workspace filter plus `entityVisible`.

Every query on `entities` or `projects` in `src/service/` applies one of them
next to the workspace filter: lists, search (lexical, vector and KEY-SEQ
match), direct lookups, id-prefix resolution, the opening brief, hierarchy and
blocker decoration, links, tags, trash, revisions, OKRs, recurrence rules.
Write paths look their target up through the same predicate, so a write to
something invisible is a 404, not a 403.

`Scope.userId` is the person a request acts for. It is null only for
background jobs and for an instance that has no accounts yet, where everything
is visible as before. Once accounts exist, the auth hook refuses any credential
that does not resolve to an active member, so a request scope always carries a
user. A direct connection from the daemon's own machine acts as the owner.

`tests/members.test.ts` runs two people through every read route and searches
the responses for a marker that exists only in the other person's private
content. A query that forgets the predicate fails there. A new read path MUST
be added to that sweep.

## Accounts and membership

- `users`, `workspace_members` (0035), `workspace_invites` (0036).
- The first account owns the instance. Everything written before it existed
  becomes the owner's: projects (kept private) and loose content.
- **Invites**: an owner or admin creates a link and sends it by any channel; no
  SMTP. The link works once, expires in 7 days, can be bound to an email, and
  only its hash is stored. The invitee sets a password; the name defaults to
  the email's local part.
- **Removing a member**: sign-in, sessions and tokens stop working. What they
  wrote stays. Their projects pass to the instance owner with the same
  visibility, so nothing is orphaned; their loose content stays hidden. A new
  invite to the same email restores the account.
- **Tokens**: created per person, stored as a hash, shown once. An owner or
  admin can list and revoke anyone's token but never read one.
- **Export and import** are owner-only. An export is a full backup and
  includes every member's content, private or not, the same as a database
  dump. Imported rows become the importer's.

## Attribution

`entities.author_user_id` records the person behind each write: the signed-in
user, or the owner of the token. Responses carry `actor.user` (the person's
name) next to the existing `actor.label` (the token name for agents).

## Known limits

- Project keys are unique across the instance, so creating a key that someone
  else holds privately fails with "already in use".
- Moving an entity out of a project makes it the mover's; other members lose
  sight of it, including worklog they wrote on it.
- A recurring task's next occurrence keeps the author of the previous one.
- OKR reviews are per person. Objectives follow their project.

## Later

1. Assignees on tasks, and "mine / everyone" filters in shared projects.
2. Personal vs team memory inside a shared project: a preference such as
   "reply in Chinese" applies to one person and must not steer a teammate's
   agent. Today such notes belong outside the project.
3. Per-person timezone.
4. Project member lists, if a team needs a project shared with some people only.
5. OIDC sign-in; email for invites and password reset.
6. botnote as its own OAuth 2.1 authorization server for hosted MCP connectors.
7. Tenancy: multi-workspace mode, sign-up policy, row-level security as a
   backstop, quotas, billing in a separate package.

## References

- Plane: https://docs.plane.so/workspaces-and-users/roles
- Linear: https://linear.app/developers/oauth-actor-authorization
- Outline: https://www.getoutline.com/integrations/oidc
- MCP authorization: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization

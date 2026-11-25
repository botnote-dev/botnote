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
user, or the owner of the token. `entity_revisions.author_user_id` records the
same for each edit. Responses carry `actor`: `label` is the person's name,
`kind` says whether they or their agent wrote it, and `token` names the API
token it came through. A person may have many tokens, so the token name is a
detail, never the author. An instance without accounts has no people, and
`label` falls back to the token name.

## Content language

One setting for the whole instance (`workspace_settings.content_language`,
owner or admin): the language agents write task titles, descriptions, worklog
and notes in. It is a fixed list of languages, and the instruction reaches
agents through the opening brief and the `context` tool. Unset, the agent
decides. It is per instance, not per person or project, because shared content
is read by everyone. It does not translate what already exists and does not
change the interface language.

## Assignees

A task has one assignee or none (`entities.assignee_user_id`).

- A new task belongs to whoever creates it: the signed-in person, or the
  owner of the agent's token. `assignee` on create or update takes `me`,
  `none`, or a member's id, email or name.
- An assignee must be able to open the task: any member in a shared project,
  only the owner in a private one, only the author outside a project. A task
  that moves where its assignee cannot follow goes to whoever moved it; a
  project that turns private hands its tasks to its owner; removing a member
  unassigns theirs.
- Everyone in a shared project still sees and can edit every task. Assignment
  says whose it is, it does not restrict access.
- An agent's session opens with its own person's tasks plus unassigned ones:
  the opening brief filters that way, and `list_tasks` defaults to it
  (`assignee: "everyone"` shows all). REST list endpoints return everyone's
  unless asked (`assignee: "mine"`).
- The web UI shows the assignee as an avatar on cards and rows, with a picker.
  One assignee filter (My tasks, Everyone, a member, Unassigned) applies to
  Today, Tasks, Inbox and shared project boards alike; it defaults to My tasks
  and is remembered per browser. `POST /v1/tasks/range` takes the same choice
  as `assignee` and applies it to every bucket. Avatars and the filter appear
  only when the instance has more than one member.
- An avatar is the person's uploaded picture (Settings → Account; cropped to
  a 256px square in the browser, PNG, JPEG or WebP, stored with the account
  and served at `/v1/users/:id/avatar` to members only) or, without one, their
  initials on a color of their own.

## Known limits

- Project keys are unique across the instance, so creating a key that someone
  else holds privately fails with "already in use".
- Moving an entity out of a project makes it the mover's; other members lose
  sight of it, including worklog they wrote on it.
- A recurring task's next occurrence keeps the author of the previous one.
- OKR reviews are per person. Objectives follow their project.

## Later

1. Personal vs team memory inside a shared project: a preference such as
   "reply in Chinese" applies to one person and must not steer a teammate's
   agent. Today such notes belong outside the project.
2. Per-person timezone.
3. Project member lists, if a team needs a project shared with some people only.
4. OIDC sign-in; email for invites and password reset.
5. botnote as its own OAuth 2.1 authorization server for hosted MCP connectors.
6. Tenancy: multi-workspace mode, sign-up policy, row-level security as a
   backstop, quotas, billing in a separate package.

## References

- Plane: https://docs.plane.so/workspaces-and-users/roles
- Linear: https://linear.app/developers/oauth-actor-authorization
- Outline: https://www.getoutline.com/integrations/oidc
- MCP authorization: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization

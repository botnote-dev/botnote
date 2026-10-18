---
name: start-work
description: Start or resume focused work from a botnote task key/id, loading the task plus its project context. Also supports project-key context loading when the user has not chosen a task yet. Triggered by /start-work TASK-KEY, /start-work PROJECT-KEY, or when the user asks to pick up work.
---

Prefer task-first starts. Project-only starts are for orientation before a task is chosen.

Argument: `<task-key-or-project-key>`.

1. Resolve the argument.
   - If it looks like a task key, such as `BOT-42` or `T2DF-7`, call `mcp__botnote__get_entity_by_key` with `key: "<KEY>"`.
   - If the exact task is not found, call `mcp__botnote__search` with `kind: "task"` and a query made from the argument, then ask the user to choose if there is more than one plausible match.
   - If it looks like a project key, such as `BOT` or `T2DF`, call `mcp__botnote__get_project` with `key: "<KEY>"`.
   - If neither path resolves, call `mcp__botnote__list_projects` and ask the user which project or task they meant.

2. When a task is resolved:
   - Confirm the entity is a task. If it is not, briefly say what was found and ask for a task key.
   - Use the task's `projectId` when present and call `mcp__botnote__opening_brief` with that `projectId`; otherwise call `mcp__botnote__opening_brief` without a `projectId`.
   - If the task is `open`, update it to `in_progress` with `mcp__botnote__update_entity`, `actorKind: "agent"`, and an idempotency key for this start-work action.
   - If the task is already `in_progress`, continue without changing it, and call `mcp__botnote__list_worklog` with the task id — the worklog records what previous sessions did and where they stopped. Summarize the latest entry in the focused-task summary.
   - If the task is `done`, `cancelled`, or otherwise terminal, do not reopen it automatically; ask whether the user wants to reopen or only review context.

3. When only a project is resolved:
   - Call `mcp__botnote__opening_brief` with the resolved `projectId`.
   - Render the brief and ask which task the user wants to start. Do not auto-pick a task unless the user clearly named one.

4. Render the brief's `markdown` field verbatim. It includes:
   - AGENTS.md project conventions
   - pinned notes
   - open tasks
   - recent activity

5. For task starts, add a concise focused-task summary after the brief:
   - task key/title
   - status
   - due date and priority when present
   - recurrence cadence when the task is recurring and `mcp__botnote__get_recurrence` is available
   - one-line next action if it is obvious from the task body

6. Treat botnote as working memory while doing the work.
   - Use `mcp__botnote__search` or `/botnote:recall` when prior decisions, related notes, similar tasks, or missing context could matter.
   - Use `mcp__botnote__remember` or `/botnote:remember` to preserve durable decisions, gotchas, useful findings, handoff notes, and final summaries.
   - When pausing work on the task (session ending, switching focus, blocked), record a worklog entry with `mcp__botnote__add_worklog`: what was done, what's next, and any blockers. This is what the next session resumes from.
   - When new work emerges that is outside the current task's scope (a discovered bug, a follow-up, an idea worth doing), propose capturing it as a new task instead of silently doing it or letting it drop. Confirm before creating; batch proposals at natural checkpoints rather than interrupting for every item. Link follow-ups to the current task via `parentId` or a reference edge.

7. After loading the focused context, ask the user what they want to do next unless they already gave a concrete implementation request.

This skill starts a focused working session. It may mark an open task `in_progress`, but it should not mark work done, cancel work, or create replacement tasks without user confirmation.

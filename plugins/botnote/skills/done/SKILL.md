---
name: done
description: Mark a botnote task as done and optionally capture closing notes. Use when the user says "done", "finished", "completed", or signals a piece of work is finished.
---

When the user signals something is finished:

1. Find the task if one is clearly available.
   - If they referenced an id like `DEMO-12`, call `mcp__botnote__get_entity_by_key`.
   - Otherwise call `mcp__botnote__search` with `kind: "task"` and a query made from the topic they described.
   - If the current conversation or loaded project context already contains one obvious task, use it even if search is weak.
   - 1 clear hit: proceed.
   - Multiple plausible hits: list them and ask which one.

2. If there is no clear existing task, treat this as a common one-off completion case. Users often say `done` after doing unplanned work, discovering and finishing a small new item, or completing something that was never captured.
   - Ask before writing: `I do not see a matching task. Should I create a completed task for "<short title>"?`
   - Infer `projectId` from the active project/context when obvious; otherwise ask for the project.
   - Use `mcp__botnote__create_task` with `status: "done"` when the user confirms.
   - If the user indicates when the work was actually finished (e.g. "did this yesterday"), pass `completedAt` with that datetime so the calendar shows it on the right day.
   - Use an executable, specific title inferred from the completed work.
   - Do not create a task silently.

3. Mark an existing task done. Call `mcp__botnote__update_entity` with the task's `id` and `status: "done"`.
   - If the user indicates the work was finished earlier (e.g. "actually finished it last Friday"), also pass `completedAt` with that datetime to backdate the completion. `completedAt` can likewise fix the timestamp on an already-done task.
   - If the task is recurring, completing it may generate the next occurrence. When recurrence matters to the user's next step, call `mcp__botnote__get_recurrence` after completion and mention the next due date if one exists.

4. Write a closing worklog entry with `mcp__botnote__add_worklog` on the task:
   - `body`: 1-3 sentences — what was done, how it was verified, and any gotchas.
   - Skip only when the user said a bare "done" with no detail and the work itself happened outside this session.
   - For durable knowledge that outlives this task (decisions, conventions, gotchas future agents need without opening this task), additionally call `mcp__botnote__remember` with `parentId` set to the task.

5. If botnote itself caused friction during this task (a tool misbehaved, a capability was missing, a workflow felt awkward), file it with `mcp__botnote__submit_feedback` (category: bug/feature/friction/idea). Check `mcp__botnote__list_feedback` first to avoid duplicates.

6. Confirm in one line:

```text
Marked task/<id8> done: <title>
```

If a worklog entry or note was captured, mention it briefly.

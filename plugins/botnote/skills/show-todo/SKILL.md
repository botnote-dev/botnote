---
name: show-todo
description: Show the current botnote task and context summary. Use when the user says "show-todo", "$show-todo", or asks what's on their plate.
---

When the user asks for today's todo/context:

1. Call `mcp__botnote__opening_brief` with no `projectId`.

2. Render the returned markdown verbatim. It includes workspace pinned notes, open tasks, and recent activity.

3. Add one concise line at the end if a specific project looks worth opening, for example:

```text
Use $start-work <TASK-KEY> to pick up a task, or $start-work <PROJECT-KEY> to load project context.
```

4. If the user starts working from this context, use recall/search for prior context, remember conclusions (decisions, preferences, gotchas) as they are drawn, and record what happened on the task with add_worklog when pausing.

botnote is the task and memory source of truth for this workflow.

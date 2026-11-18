---
name: remember
description: Store a memory in botnote — a conclusion to apply again: a decision and its reason, a preference, a gotcha, a convention. Use whenever the user says "remember X", "store this", "save this for later", or states a decision or preference. A record of what happened on a task goes to its worklog instead.
---

When the user wants to remember something:

1. Call `mcp__botnote__remember` with:
   - `body`: the content to store. Markdown and multi-line text are allowed.
   - `title`: optional. Skip it when the body's first line is already a clear label. Provide it when the body is long-form.
   - `tags`: short kebab-case strings inferred from the content, usually 2-4 tags.
   - `projectId`: include only if the user explicitly mentioned a project or it is clear from the current context.
   - `pinned`: `true` only when the user says this should be pinned, always shown, or treated as must-read project context.
   - `parentId`: the task this memory came out of, if any. It records the source; the memory still applies beyond that task.

2. Report back in one line:

```text
Remembered <ref>: <displayTitle>
```

`<ref>` is the KEY-SEQ (or short id) the tool returned.

Do not call `mcp__botnote__remember` multiple times for one piece of content. If the user dictates several distinct items in one message, ask whether they want one combined note or one note per item.

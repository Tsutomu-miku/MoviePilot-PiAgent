---
name: task-status
description: Inspect downloads, native subscriptions and library presence using authoritative observations.
---

Use get_tasks for this conversation's own tasks. get_downloading shows only active MP downloads and excludes completed tasks.

Report awaiting_confirmation, submitted, downloading, downloaded, imported, failed or unknown exactly as observed. A task disappearing from an active list is not evidence of completion. An unknown submission must be checked in the backend; never submit it again automatically.

Use check_library with the exact media key and required season/episodes. Existing content may predate this request. Only a newly absent-then-present library result or a matching MP transfer history can establish this task's import.

Native subscriptions are distinct from Mikan RSS. Pause, resume and delete require a preview and subsequent explicit confirmation.

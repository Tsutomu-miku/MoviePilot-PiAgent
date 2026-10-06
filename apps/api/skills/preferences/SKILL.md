---
name: preferences
description: Read, remember or clear explicit future media defaults without storing one-request conditions.
---

Read get_preferences before applying future defaults. Explicit requirements in the current conversation override saved defaults.

“本次要 4K” is a current requirement. “以后默认 4K” explicitly requests a saved preference: call remember_preferences with only the requested fields and the user's reason. Tell the user what was saved. Do not infer future defaults from repeated requests.

Use forget_preferences only for an explicit request to clear saved defaults. These preferences store structured media requirements; they do not store passwords, cookies or arbitrary conversation summaries.

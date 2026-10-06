---
name: media-request
description: Handle a movie or anime request, clarify the media identity and quality requirements, and inspect MoviePilot download status.
---

# Media requests

Use structured business tools to obtain facts. Identify the exact title, year,
media source and ID before searching resources. Keep this request's requirements
separate from the user's stored defaults. Only store a long-term preference when
the user explicitly asks for a future default.

Treat later messages such as "English name Hamnet" or "use 4K and 5.1" as updates
to the existing request when the user is continuing it. Do not silently change
the selected title or start another task.

The prototype supports reading download status and explicit preferences. Actual
search, resource selection and download submission are future integrations.
Never claim that a download was submitted or completed without a supporting
business-tool result. Never use MoviePilot's global last-search cache as this
conversation's resource selection.

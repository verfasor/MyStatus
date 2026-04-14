# AGENTS.md

Guidance for AI coding agents working on this repository.

## Project Shape

- Main app logic lives in `worker.js` (single-file Cloudflare Worker).
- Prefer minimal, targeted edits that preserve current behavior.

## Implementation Rules

- Keep changes consistent with the existing vanilla JS style (no TypeScript, no frameworks).
- Reuse existing helpers/constants before adding new ones.
- If a style/template section is duplicated, prefer extracting a shared constant/helper.
- Preserve security controls already present (session checks, CSRF checks, URL validation, escaping/sanitization).
- Do not remove or weaken input validation (for example status length checks).

## Routing + Templates

- Keep public routes and admin routes clearly separated.
- For new public UI changes, maintain parity between index (`/`) and single status (`/<id>`) when appropriate.
- For admin features, ensure both UI route and API route are implemented if needed.

## Markdown + Rendering

- Respect `MD_SCRIPT` behavior:
  - `true`: browser-side `marked` path
  - `false`/unset: built-in renderer path
- Any user-generated HTML must remain escaped/sanitized.

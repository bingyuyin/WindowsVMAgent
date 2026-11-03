---
name: coding-best-practices
description: Engineering standards for implementing a change - understand the code first, focused diffs, local conventions, error handling, security, tests and validation before submitting.
---

# Coding best practices

Apply these defaults unless the repository's own instructions (AGENTS.md, .github/copilot-instructions.md,
CONTRIBUTING.md, ...) say otherwise. Repository guidance always wins.

## Before editing
- Read the relevant code paths end to end and find the existing pattern for this kind of change; follow it.
- Find how the project builds, lints and tests: package scripts, Makefile, solution files, CI workflows
  under `.github/workflows`.
- Note public contracts you might touch: exported APIs, CLI flags, config keys, schemas, wire formats.

## Making the change
- Keep the diff focused on the request: no drive-by refactors, renames or reformatting.
- Match local conventions: naming, file layout, error-handling style, logging, dependency injection.
- Prefer existing utilities and dependencies; justify any new dependency in your summary.
- Validate input at boundaries and fail with actionable messages; never swallow errors silently.
- Think through edge cases: empty/null input, very large input, concurrency, time zones, encodings,
  platform path differences, partial failure.
- Security: no secrets in code or logs; validate and escape untrusted input; least privilege; safe defaults.
- Performance: avoid I/O inside loops and N+1 access; keep complexity proportional to the data.
- Keep public APIs backward compatible unless the request requires otherwise; call out breaking changes.
- Comment only where intent is not obvious; update docs that describe changed behavior.

## Tests
- Add or update tests beside the existing ones, using the same framework and style.
- Cover the main path, the edge cases and the failure modes named in the request.
- Keep tests deterministic: no real network, clock or randomness unless the suite already does so.

## Before submitting
- Run the build, linters and the relevant tests; fix every failure your change causes.
- If something cannot be run (missing toolchain, credentials), state exactly what and why.
- Review your own diff (`git diff`): remove debug output, temporary files and unrelated edits.

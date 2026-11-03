---
name: code-review
description: Senior-engineer code review checklist with severity guidance and how to write actionable comments. Use when reviewing a diff.
---

# Code review

Review the change as a whole first (does it do what was asked, is the approach sound?), then line by line.
Verify claims by reading the code; do not guess. Repository review guidelines take precedence.

## Checklist
1. **Correctness** - logic errors, off-by-one, null/undefined handling, wrong conditions, parts of the
   request that are missing.
2. **Edge cases and failure modes** - invalid or empty input, timeouts, retries, partial failure, races.
3. **Security** - injection, path traversal, unsafe deserialization, secrets, missing authorization,
   unsafe defaults.
4. **Error handling and resources** - errors carry context, no silent catches, files/locks/connections
   are released.
5. **Tests** - new behavior covered, edge cases tested, meaningful assertions, deterministic.
6. **Design and maintainability** - fits the existing architecture and conventions, no needless
   complexity or duplication, clear names.
7. **Compatibility** - public API, contract, schema or config changes; migrations; docs updated.
8. **Performance** - hot paths, N+1 access, unbounded memory, blocking I/O on critical paths.

## Severity
- **blocker** - incorrect, unsafe, breaks the build or tests, or does not implement the request.
- **major** - significant bug risk, missing tests for core behavior, maintainability problems.
- **minor** - worthwhile improvement that is safe to defer.
- **nit** - polish. Never withhold approval for nits.

## Writing comments
- One issue per comment, with file and line, the impact, and the expected fix.
- Prefer a few high-signal comments over many trivial ones; skip pure formatting unless it breaks
  repository conventions.
- Approve when no blocker or major issue remains.

## Re-review
- Check every previous comment against the new diff and the author's response; accept reasoned declines.
- Raise new issues only if they are significant or were introduced by the fixes.

---
name: review-comment-resolution
description: How to resolve code review comments - triage each comment, fix root causes, decline only with technical reasons, re-validate, and respond to every comment ID.
---

# Resolving review comments

1. Read every open comment and the code it points to before changing anything. Group related comments.
2. Decide per comment: **fix** (default) or **decline** - only when the comment is incorrect, out of
   scope for the request, or conflicts with repository conventions. "Too much work" is not a reason.
3. Fix the root cause, not just the cited line; look for other occurrences of the same problem.
4. Keep the fix focused; do not rewrite unrelated code while addressing feedback.
5. Add or adjust tests for each behavioral fix so the reviewer can see it is covered.
6. Re-run the build and the relevant tests after all fixes, and report the results.
7. Respond to every comment ID: `addressed` with what changed (file, function, test), or `declined` with
   a concrete technical reason. Never leave a comment unanswered.

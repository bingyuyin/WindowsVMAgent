---
name: test-fixing
description: How to fix failing tests at the root cause - reproduce, decide whether the product or the test is wrong, fix minimally, verify, and never game the tests. Use when fixing test failures reported by a test run.
---

# Fixing test failures

The goal is correct software, not green checkmarks. A test the executor reports as failing is evidence;
treat it like a bug report.

## Workflow
1. **Reproduce**: run the single failing test (`npm test -- -t "<name>"`, `dotnet test --filter`,
   `pytest path::test`, `Invoke-Pester -FullNameFilter`) and read the full failure.
2. **Locate**: follow the stack into the repository; read the test, the code under test, and the
   request/specification (design docs, README, comments, issue text).
3. **Decide what is wrong**:
   - The code violates the documented/required behavior -> fix the **product code**.
   - The test asserts something the specification does not require, depends on timing, order or
     machine state, or has broken setup -> fix the **test**, and say why in your response.
   - Both may be wrong; fix both.
   - Environment (missing tool, credential, service) -> you cannot fix it in code; decline with exactly
     what is needed.
4. **Fix minimally** at the root cause, following the repository's conventions. Do not refactor
   unrelated code.
5. **Verify**: re-run the failing test, then the related tests or the whole suite if it is fast.
   Report the commands and results in `validation`.

## Never
- Delete, skip or comment out tests (`.skip`, `[Ignore]`, `-Skip`, `@pytest.mark.skip`).
- Weaken assertions (exact -> approximate, specific -> generic, removing checks).
- Catch and ignore exceptions to make a test pass.
- Hard-code the value a test expects, or special-case test inputs in product code.
- Change an expectation to match buggy behavior.

The test executor inspects your diff and reports such changes as integrity failures.

## Flaky tests
Fix the cause (shared state, ordering, real time/sleeps, unawaited async work, port/file collisions).
Add retries only as a last resort and say so explicitly.

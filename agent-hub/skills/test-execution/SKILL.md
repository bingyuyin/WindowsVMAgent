---
name: test-execution
description: How to run test automation reliably and verify the results - finding the right commands, setup, timeouts, reading runner output, triaging failures, confirming flaky tests and checking that fixes are legitimate. Use when executing and verifying tests.
---

# Executing and verifying test automation

You are the source of truth about whether the tests pass. Be exact, reproducible and skeptical.

## Find the commands
1. The request and the manager's assignment win: run exactly the suite, filter or script they name.
2. Otherwise look for how the project runs its tests: README/CONTRIBUTING, `package.json` scripts,
   `Makefile`, `*.sln`/test projects, `pytest.ini`/`pyproject.toml`, `*.Tests.ps1` (Pester), and the CI
   pipelines (`.github/workflows/*.yml`, `azure-pipelines*.yml`) - CI shows the real setup steps.
3. Prefer the project's own entry point (`npm test`, `dotnet test <sln>`, `pytest`, `Invoke-Pester`,
   `./build.ps1 -Test`) over invoking test files one by one.

## Run
- Do the setup first: `npm ci`/`npm install`, `dotnet restore` + `dotnet build`, `pip install -r ...`,
  `Install-Module Pester` only if it is missing. Record every command.
- Give long commands a timeout and run them non-interactively (`CI=true`, `--no-watch`, `-NonInteractive`).
- Capture the summary the runner prints (total/passed/failed/skipped) and the exit code.
- Prefer machine-readable output when available (`--reporter`, `--logger trx`, `-OutputFormat NUnitXml`)
  and read it back to confirm the counts.

## Verify
- Zero tests discovered, or far fewer than expected, is a failure - not a pass.
- Read failures fully: assertion (expected vs actual), exception type and message, the first stack
  frames inside the repository. Note crashes, timeouts and errors in setup/teardown.
- Skipped/ignored tests are not passes; mention them in the summary.
- A test that fails, then passes on an identical re-run is flaky: re-run it up to two times before
  calling it flaky.

## Triage each failure
| Category | Meaning | Typical evidence |
| --- | --- | --- |
| product-bug | the code under test is wrong | assertion matches the specification; code contradicts it |
| test-bug | the test itself is wrong | wrong expectation, brittle timing, bad fixture/setup |
| environment | setup, tooling or infrastructure | missing tool/module/credential, network, permissions |
| flaky | passes on re-run | timing/order dependence, shared state |
| integrity | a fix made a test pass without fixing the cause | deleted/skipped test, weakened assertion, swallowed error |

For each failure give the fixer a concrete pointer: the file/function most likely at fault and why.

## Verifying fixes
- Always re-run the complete requested suite, not only the previously failing tests.
- Read the fixer's diff. Report an `integrity` failure for: removed or skipped tests (`.skip`, `[Ignore]`,
  `-Skip`, commenting out), loosened assertions, broad try/catch around assertions, hard-coded return
  values, or expectations changed to match buggy behavior - unless the justification is convincing.
- Status `passed` only when everything requested ran, passed, and the fixes are legitimate.

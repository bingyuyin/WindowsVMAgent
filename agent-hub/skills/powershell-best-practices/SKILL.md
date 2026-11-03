---
name: powershell-best-practices
description: Best practices for PowerShell scripts and modules - editions, PSScriptAnalyzer, advanced functions, error handling, output, security and Pester tests. Use when designing, writing, reviewing or testing PowerShell code.
---

# PowerShell best practices

The repository's own conventions (PSScriptAnalyzer settings, module layout, build scripts, AGENTS.md)
win over this list.

## Tooling
- Target the edition the repository uses: Windows PowerShell 5.1 or PowerShell 7 (`pwsh`). Check
  `#Requires`, module manifests (`PowerShellVersion`, `CompatiblePSEditions`) and CI before using newer
  syntax such as `??`, ternaries or `ForEach-Object -Parallel`.
- Lint with PSScriptAnalyzer (`Invoke-ScriptAnalyzer -Path . -Recurse`, with the repository's settings
  file when there is one) and fix the findings you introduce.
- Run scripts non-interactively: `pwsh -NoProfile -NonInteractive -File script.ps1`. Never leave
  `Read-Host`, `Pause` or credential prompts on automation paths.

## Code
- Approved verbs (`Get-Verb`) and `Verb-Noun` names; `[CmdletBinding()]` with typed, validated
  parameters (`[ValidateNotNullOrEmpty()]`, `[ValidateSet()]`); `SupportsShouldProcess` for functions
  that change state.
- Errors: use `-ErrorAction Stop` (or `$ErrorActionPreference = 'Stop'`) where a failure must stop the
  script; `try`/`catch` specific errors; check `$LASTEXITCODE` after native commands.
- Emit objects, not formatted text; use `Write-Verbose`, `Write-Warning` or `Write-Information` for
  messages instead of `Write-Host` in reusable code.
- Full cmdlet and parameter names in scripts (no aliases such as `%`, `?`, `ls`); `Join-Path` for paths;
  `Set-StrictMode -Version Latest` where the repository uses it.
- Avoid `Invoke-Expression`; pass arguments to native commands as arrays.

## Security
- No plaintext secrets: use `PSCredential`/`SecureString`, SecretManagement or secrets provided by the
  environment, and never write them to logs or output.

## Tests
- Pester: check whether the tests use v4 or v5 syntax and stay consistent (`BeforeAll`, `Should -Invoke`
  and `-ForEach` are v5).
- Run `Invoke-Pester -Path <tests> -CI` with Pester 5 (`-EnableExit` with v4); mock external commands with
  `Mock ... -ParameterFilter` and use `TestDrive:` for files.

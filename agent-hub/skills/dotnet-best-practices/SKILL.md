---
name: dotnet-best-practices
description: Best practices for .NET and C# code - SDK and solution tooling, nullable reference types, async/await, dependency injection, logging, security and testing with dotnet test. Use when designing, writing, reviewing or testing .NET code.
---

# .NET and C# best practices

The repository's own conventions (.editorconfig, Directory.Build.props, analyzers, global.json,
AGENTS.md) win over this list.

## Tooling
- Build and test the solution or project the repository uses: `dotnet restore`, `dotnet build
  --no-restore`, `dotnet test --no-build`. Respect `global.json`, target frameworks and central package
  management (`Directory.Packages.props`).
- Fix new compiler and analyzer warnings instead of suppressing them; justify any suppression.
- Run commands non-interactively (`--nologo`, `-v minimal`); never `dotnet watch` or interactive prompts.

## Code
- Keep nullable reference types correct: no `!` to silence warnings; validate arguments
  (`ArgumentNullException.ThrowIfNull`, `ArgumentException.ThrowIfNullOrEmpty` on newer .NET).
- Async all the way: `Task`/`ValueTask`, pass `CancellationToken` through, never `.Result`, `.Wait()` or
  `async void` (except event handlers); use `ConfigureAwait(false)` in libraries if the codebase does.
- Dispose with `using`/`await using`; create HTTP clients through `IHttpClientFactory`.
- Follow the existing dependency injection, options (`IOptions<T>`) and logging patterns; log with
  message templates (`logger.LogInformation("Saved {Id}", id)`), not string interpolation.
- Catch specific exceptions, rethrow with `throw;` to keep the stack, and never use exceptions for
  control flow.
- Prefer immutable records and `readonly` fields for data; watch LINQ for multiple enumeration and EF Core
  for N+1 queries and missing `AsNoTracking` on read paths.

## Security
- Parameterized queries only (EF Core, Dapper parameters); never build SQL from strings.
- Validate and encode untrusted input; keep secrets out of code and committed appsettings; use
  `RandomNumberGenerator` for tokens.

## Tests
- Use the framework in place (xUnit, NUnit, MSTest) with its assertion and mocking libraries and the
  existing naming style.
- `dotnet test <sln or csproj> --no-build --logger trx --blame-hang-timeout 10m` records results and
  dumps a hanging test instead of waiting forever; use `--filter FullyQualifiedName~Name` for a quick
  loop, then run the full suite.
- Keep tests deterministic: inject time (`TimeProvider` or the codebase's clock), avoid real network.

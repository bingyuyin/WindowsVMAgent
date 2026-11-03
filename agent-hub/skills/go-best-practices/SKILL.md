---
name: go-best-practices
description: Best practices for Go code - modules and tooling, error handling, interfaces, context, goroutine safety, security and table-driven tests. Use when designing, writing, reviewing or testing Go code.
---

# Go best practices

The repository's own conventions (golangci-lint configuration, Makefile targets, AGENTS.md) win over
this list.

## Tooling
- `go build ./...`, `go vet ./...` and `go test ./...`; run `golangci-lint run` when configured.
- Code is gofmt'ed (`gofmt -l .` prints nothing); keep imports grouped the way goimports does.
- After dependency changes run `go mod tidy` and commit `go.mod` and `go.sum` together.

## Code
- Handle every error and add context when wrapping: `fmt.Errorf("load config: %w", err)`; compare with
  `errors.Is`/`errors.As`; panic only for programmer errors.
- Accept interfaces, return concrete types; keep interfaces small and define them where they are used.
- Pass `context.Context` as the first parameter of I/O and long-running functions and honor cancellation.
- Every goroutine has an owner and a way to stop; guard shared state with a mutex or channels; the sender
  closes a channel; avoid leaks on early returns.
- `defer` the `Close`/`Unlock` right after acquiring; check `Close` errors on writers.
- Idiomatic names: MixedCaps, short receivers, no stutter (`config.Config` not `config.ConfigConfig`);
  doc comments on exported identifiers.

## Security
- `exec.Command` with separate arguments, never a shell string with untrusted input.
- `database/sql` placeholders; `crypto/rand` for secrets; clean and contain file paths
  (`filepath.Clean` plus a prefix check, or `os.Root` on newer Go).

## Tests
- Table-driven tests with `t.Run`; use `t.Helper()`, `t.TempDir()`, `t.Cleanup()`; add testify only if
  the project already uses it.
- `go test ./... -count=1 -timeout 10m` (add `-race` when cgo is available); `-run TestName` for a quick
  loop.

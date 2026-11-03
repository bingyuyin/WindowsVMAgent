---
name: rust-best-practices
description: Best practices for Rust code - cargo tooling, error handling, ownership, unsafe, async, security and tests. Use when designing, writing, reviewing or testing Rust code.
---

# Rust best practices

The repository's own conventions (rustfmt.toml, clippy configuration, workspace layout, MSRV,
AGENTS.md) win over this list.

## Tooling
- `cargo build`, `cargo test`, `cargo fmt --check` and `cargo clippy --all-targets` (with
  `-- -D warnings` when CI does). Respect the workspace, feature flags and `rust-version`.
- Add dependencies with the features you need only; keep `Cargo.lock` changes intentional.

## Code
- Return `Result` and use `?`. Libraries define error types (for example with `thiserror`); applications
  may use `anyhow` with `.context(...)`.
- No `unwrap()`/`expect()` on fallible runtime paths; outside tests, only for proven invariants and with
  a message that says why.
- Borrow in parameters (`&str`, `&[T]`, `impl AsRef<Path>`), avoid needless `clone()`, prefer iterators.
- `unsafe` only when unavoidable, in the smallest scope, with a `// SAFETY:` comment explaining why it
  holds.
- Async: don't block the runtime (use `spawn_blocking`), don't hold a lock across `.await`, give network
  calls timeouts.
- Document public items (`///`) and derive common traits (`Debug`, `Clone`, `PartialEq`) where sensible.

## Security
- `std::process::Command` with separate arguments; parameterized queries (sqlx, diesel); bound sizes of
  untrusted input; no secrets in code.

## Tests
- Unit tests in a `#[cfg(test)] mod tests` next to the code, integration tests in `tests/`; doc tests for
  public examples.
- `cargo test <name>` for a quick loop, then the full `cargo test`; `-- --nocapture` only when debugging.

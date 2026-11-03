---
name: typescript-best-practices
description: Best practices for TypeScript, JavaScript and Node.js code - package tooling, strict typing, async and error handling, security, tests and non-interactive validation commands. Use when designing, writing, reviewing or testing TS/JS code.
---

# TypeScript, JavaScript and Node.js best practices

The repository's own conventions (tsconfig, ESLint/Prettier/Biome config, package scripts, AGENTS.md)
win over this list.

## Tooling
- Use the package manager the lockfile implies (`package-lock.json` npm, `pnpm-lock.yaml` pnpm,
  `yarn.lock` yarn) and install exactly from the lockfile: `npm ci`, `pnpm install --frozen-lockfile`,
  `yarn install --immutable` (Yarn 1: `--frozen-lockfile`). Never edit lockfiles by hand.
- Respect `engines`, `"type": "module"` vs CommonJS, path aliases and the module style already in use.
- Validate with the project's scripts: `build`, `lint`, `typecheck` (or `tsc --noEmit`) and `test`.

## Types
- Keep `strict` typing: no new `any`, `@ts-ignore` or non-null `!` without a reason. Prefer `unknown`
  with narrowing, discriminated unions, `readonly` data and `satisfies` for checked literals.
- Type exported functions and public APIs explicitly; let inference handle locals.
- Untrusted input (HTTP bodies, JSON, environment variables, files) is validated at the boundary with
  the project's schema library or explicit checks before its type is trusted.

## Async and errors
- Await or return every promise (no floating promises); `Promise.all` for independent work, bounded
  concurrency for large fan-outs.
- Throw `Error` objects (with `cause` when wrapping), never strings; no empty `catch` blocks.
- Release timers, listeners, streams and child processes (`finally`, `AbortController`); no synchronous
  file or network I/O on request paths.

## Security
- No `eval`/`new Function`; spawn processes with `execFile`/`spawn` and argument arrays, not shell strings.
- Resolve file paths and check they stay inside the intended root; escape HTML output; keep secrets out
  of code, logs and error messages.
- Prefer existing, maintained dependencies; justify any new one.

## Tests
- Use the framework already in place (node:test, Vitest, Jest, Mocha, Playwright) and its layout.
- Run tests non-interactively: `CI=true npm test`, `vitest run`, `jest --ci`, never watch mode; run the
  affected test file first, then the whole suite.
- Mock time, network and randomness the way the suite does; keep tests deterministic and isolated.

## Pitfalls
- `==` vs `===`, lost `this` in callbacks, mutating shared objects, floating-point money, `Date` time
  zones, `JSON.parse` without error handling, `forEach` with async callbacks.
- Build paths with `path.join`/`path.resolve` (Windows separators), not string concatenation.

---
name: java-best-practices
description: Best practices for Java and Kotlin (JVM) code - Maven/Gradle tooling, null safety, resources, exceptions, concurrency, security and JUnit tests. Use when designing, writing, reviewing or testing JVM code.
---

# Java and Kotlin (JVM) best practices

The repository's own conventions (build scripts, Checkstyle/Spotless/ktlint/detekt configuration,
AGENTS.md) win over this list.

## Tooling
- Use the wrapper when present (`./mvnw`, `./gradlew`) and run in batch mode: `mvn -B -ntp verify`,
  `./gradlew build --no-daemon --console=plain`. Respect the configured Java version (toolchains,
  `maven.compiler.release`).
- Keep the build free of new compiler warnings and formatter/linter findings.

## Code
- Null safety: validate arguments (`Objects.requireNonNull`), return `Optional` instead of null where the
  codebase does (not for fields or parameters); in Kotlin avoid `!!`.
- Close resources with try-with-resources (Kotlin `use {}`), including streams, connections and executors.
- Catch specific exceptions, keep the cause when wrapping, never leave a catch block empty, and don't log
  and rethrow the same exception at every layer.
- Concurrency: use `java.util.concurrent` (executors, `CompletableFuture`) or coroutines; prefer immutable
  data (records, `final`, Kotlin `val` and data classes); guard shared mutable state.
- Follow the framework's patterns (Spring dependency injection, configuration properties); log through
  SLF4J with `{}` placeholders.
- Keep `equals`, `hashCode` and `toString` consistent (records help).

## Security
- Prepared statements or JPA parameters, never concatenated SQL or JPQL.
- Validate and encode untrusted input; never deserialize untrusted data with Java serialization; use
  `SecureRandom` for tokens; keep secrets out of committed configuration.

## Tests
- JUnit 5 (or the framework in place) with the existing assertion and mocking libraries (AssertJ,
  Mockito, MockK).
- Quick loop: `mvn -B -ntp test -Dtest=ClassName` or `./gradlew test --tests 'ClassName'`; then the full
  `verify`/`build`.
- No `Thread.sleep` waits: use latches or Awaitility; bound slow tests with `@Timeout`.

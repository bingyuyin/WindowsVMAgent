---
name: cpp-best-practices
description: Best practices for C and C++ code - build systems, RAII and ownership, bounds and integer safety, error handling, concurrency, Windows APIs and tests. Use when designing, writing, reviewing or testing C/C++ code.
---

# C and C++ best practices

The repository's own conventions (.clang-format, .clang-tidy, build presets, coding guidelines,
AGENTS.md) win over this list.

## Tooling
- Build with the project's system: CMake (`cmake --preset ...` or `cmake -S . -B build` then
  `cmake --build build`), MSBuild solutions, Meson or Make. Keep its language standard, flags and warning
  level, and keep the build warning-free.
- Run the configured formatter and linters (`clang-format`, `clang-tidy`) on the files you change only.

## C++
- RAII for every resource: containers, `std::unique_ptr`/`std::make_unique`, smart handles and scope
  guards; no naked `new`/`delete` or `malloc`/`free`.
- `const`-correctness, `enum class`, `override`, `= default`/`= delete`; use `std::string_view` and
  `std::span` for non-owning views and check that the data outlives them.
- Bounds and integers: prefer range-for and algorithms to raw indexing, validate sizes from untrusted
  input, watch for overflow and signed/unsigned mix-ups in arithmetic and comparisons.
- Errors: follow the codebase's model (exceptions, error codes, `std::expected`, HRESULT) and never ignore
  a returned error.
- Concurrency: `std::mutex` with `std::scoped_lock`, `std::atomic` for flags and counters, no data races;
  join or stop every thread you start.
- Windows: use the wide-character (`W`) APIs, wrap handles in RAII types (for example WIL when the
  project uses it) and check every `HRESULT` with the project's macros.

## C
- Check every allocation and return value and free on every path; use `snprintf` and length-bounded
  functions, never `gets`, `strcpy` or `sprintf`.

## Tests
- Use the framework in place (GoogleTest, Catch2, doctest, CTest, TAEF) and add tests next to the
  existing ones.
- `ctest --test-dir build --output-on-failure --timeout 600`, or run the test binary directly with a
  filter for a quick loop; build with sanitizers (ASan, UBSan) when the project supports them.

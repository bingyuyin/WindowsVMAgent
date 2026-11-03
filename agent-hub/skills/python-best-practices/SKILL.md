---
name: python-best-practices
description: Best practices for Python code - environments and packaging, typing, error handling, logging, asyncio, security and pytest. Use when designing, writing, reviewing or testing Python code.
---

# Python best practices

The repository's own conventions (pyproject.toml, ruff/flake8/black/mypy configuration, tox/nox,
AGENTS.md) win over this list.

## Tooling
- Work in the project's environment (its venv, Poetry, uv, pipenv or conda setup) and install the way it
  documents: `pip install -e ".[dev]"`, `poetry install`, `uv sync`, `pip install -r requirements*.txt`.
  Don't install into the global interpreter when a virtual environment exists.
- Validate with the configured tools: `ruff check` or `flake8`, `ruff format --check` or `black --check`,
  `mypy` or `pyright`, and `pytest`.
- Add dependencies where the project declares them (pyproject, requirements, lock file) and justify them.

## Code
- Follow PEP 8 and the existing style; annotate new public functions; prefer `pathlib`, f-strings and
  dataclasses or the models the codebase already uses.
- No mutable default arguments; use context managers for files, locks and connections.
- Catch specific exceptions, chain them (`raise NewError(...) from err`), never use a bare `except:` or a
  silent `pass`.
- Use `logging` with lazy `%s` arguments in library and service code, not `print`.
- asyncio: never block the event loop with synchronous I/O; await or track every task; bound external
  calls with timeouts (`asyncio.timeout` on 3.11+, otherwise `asyncio.wait_for`).

## Security
- `subprocess.run([...], check=True)` with argument lists; no `shell=True` with untrusted input.
- Parameterized SQL; `yaml.safe_load`; never `pickle`, `eval` or `exec` on untrusted data; `secrets` for
  tokens; validate file paths stay inside the intended directory.

## Tests
- Use pytest (or the unittest suite already in place) with fixtures and `parametrize`; put tests next to
  the existing ones.
- Run non-interactively and bounded: `python -m pytest -q -x <path>` for the quick loop, the full suite
  before submitting; add `--timeout=600` when pytest-timeout is installed.
- Mock network and time the way the suite does (`monkeypatch`, `freezegun`, `responses`); use `tmp_path`
  for files.

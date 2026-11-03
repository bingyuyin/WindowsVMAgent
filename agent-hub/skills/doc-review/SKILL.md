---
name: doc-review
description: Checklist for reviewing technical documentation - accuracy against the repository, completeness for the audience, structure, examples, and presentation of light-themed HTML documents. Use when reviewing documentation.
---

# Reviewing documentation

Check every factual statement you can against the repository: commands, paths, configuration keys,
defaults, API names and behavior. Inaccurate documentation is worse than missing documentation.

## Checklist
- **Request fit** - covers what was asked, for the intended audience; nothing important is missing.
- **Accuracy** - commands exist and work as written; paths, options, defaults and APIs match the code.
- **Examples** - runnable, minimal and consistent with the current code; placeholders are obvious.
- **Structure** - overview first; task-oriented sections; procedures as numbered steps; reference
  data in tables; troubleshooting covers real failure modes.
- **Clarity** - short sentences, consistent terminology, no unexplained jargon or ambiguity.
- **Visuals** - diagrams where they clarify architecture or flows, with valid Mermaid syntax.
- **HTML presentation** - no leftover template placeholders (`data-placeholder`), a clear heading
  hierarchy, light theme kept, no external stylesheets, fonts or images and no scripts other than the
  template's Mermaid loader (`<script data-hub-mermaid>`), which is expected and must stay.
- **Safety** - no secrets, internal hostnames or personal data; security-relevant steps carry warnings.

## Severity
- **blocker** - wrong or misleading content that would cause failures or unsafe actions.
- **major** - significant gap or inaccuracy; a required topic is missing.
- **minor** - clarity, structure or completeness improvement. **nit** - wording or polish.

Approve when no blocker or major issue remains. On re-review, verify each previous comment against the
revision and the writer's response, and accept reasonable declines.

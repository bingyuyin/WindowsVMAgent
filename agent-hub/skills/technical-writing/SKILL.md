---
name: technical-writing
description: Structure and quality bar for technical documentation - audience, task-oriented structure, accuracy against the code, runnable examples, diagrams and light-themed HTML presentation. Use when writing documentation.
---

# Writing technical documentation

Documentation is only useful when it is accurate. Read the code, configuration and scripts you
describe; run or trace commands where possible. If the repository has a documentation style guide or
template, follow it instead of this outline.

## Before writing
- Identify the **audience** (new contributor, operator, API consumer, end user) and the **job** the
  reader needs to get done. Write for that job, not for completeness.
- Collect facts from the repository: entry points, commands (`package.json` scripts, Makefile, CI),
  configuration options and defaults, environment variables, APIs and error messages.

## Structure
1. **Overview** - what it is, who it is for, what the reader can do afterwards (2-4 sentences).
2. **Prerequisites** - tools, versions, access.
3. **Task-oriented sections** - one goal per section, ordered by what readers need first
   (quick start, common tasks, then advanced topics). Use numbered steps for procedures.
4. **Reference** - tables for options, commands, endpoints, fields (name, type, default, description).
5. **Troubleshooting / FAQ** - real failure modes with cause and fix.
6. **Related resources** - links to files and documents in the repository.

## Style
- Short paragraphs, active voice, present tense, second person ("Run...", "You can...").
- Concrete over vague: exact commands, paths, values and expected output.
- Examples must be copy-paste runnable and consistent with the code; mark placeholders clearly.
- Explain *why* where it prevents mistakes (constraints, gotchas, security notes).
- Prefer a diagram for architecture, flows and lifecycles; prefer a table for comparisons and options.

## HTML documents (light theme)
- Keep the hub template's `<head>`/`<style>`; fill every `data-placeholder` element and remove the attribute.
- Lead with the overview `.lead` paragraph and `.cards`; use `.callout.tip` / `.callout.warn` for
  tips and pitfalls, `ol.steps` for procedures, tables for reference data, `.badge` for status labels.
- Diagrams: `<figure class="diagram"><pre class="mermaid">...</pre><figcaption>...</figcaption></figure>`
  with valid Mermaid (flowchart, sequenceDiagram, stateDiagram-v2, erDiagram, classDiagram).
  Write `<` as `&lt;` inside diagrams and code blocks.
- No external stylesheets, fonts, images or scripts; keep the light color palette. The template's
  Mermaid loader (`<script data-hub-mermaid>`) is the one allowed script - keep it unchanged.

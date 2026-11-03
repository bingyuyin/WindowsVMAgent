---
name: system-design
description: Structure and quality bar for technical design documents - requirements, architecture, data and APIs, non-functional requirements, trade-offs, risks, rollout and testing. Use when writing a design.
---

# Writing a system design document

Ground every decision in the actual repository: cite existing modules, interfaces, data stores and
patterns. If the repository has a design-doc or ADR template, follow it instead of this outline.

## Outline
1. **Title, status, summary** - the problem and the proposed solution in 3-5 sentences.
2. **Context and problem** - who is affected; current behavior with file references.
3. **Goals and non-goals** - explicit scope boundaries.
4. **Requirements** - functional; non-functional with concrete targets where they matter (latency,
   throughput, scale, availability, security, privacy, compliance, accessibility).
5. **Proposed design** - components and responsibilities; data flow (a mermaid diagram helps);
   interfaces and API signatures; data model and schema changes; error handling and retries;
   concurrency; configuration.
6. **Alternatives considered** - with trade-offs and why each was rejected.
7. **Risks and mitigations** - failure modes, backward compatibility, migration, rollback.
8. **Security and privacy** - threats, authentication/authorization, data handling.
9. **Observability** - logs, metrics, traces and alerts that show the system is healthy.
10. **Testing and validation plan** - unit, integration, end-to-end, performance.
11. **Rollout plan** - phases, feature flags, rollback criteria.
12. **Implementation plan** - ordered, independently shippable tasks.
13. **Open questions**.

## Quality bar
- Concrete over generic: name files, types, endpoints, limits and numbers.
- Choose the simplest design that meets the requirements; justify any added complexity.
- Make trade-offs explicit (consistency vs. availability, latency vs. cost, build vs. buy).
- Keep it reviewable: short sections, tables for comparisons, diagrams for flows.

## HTML design documents (light theme)
- The request sets the scope and length: the template's sections are a menu, not a checklist. For a
  short design keep only what the request needs (summary, proposed design with diagram, key risks).
- Keep the hub template's `<head>`/`<style>` and section skeleton; fill every `data-placeholder`
  element and remove the attribute; delete sections that do not apply.
- Put the summary and key decision first (`.callout`, `dl.facts`); goals vs. non-goals in `.pros-cons`;
  requirements, components, alternatives and risks in tables; `.badge` for status (New, Modified,
  Rejected, High risk); `ol.steps` for the implementation plan; `.callout.risk` / `.callout.decision`
  to highlight risks and decisions.
- Draw the architecture (flowchart) and the main flows (sequenceDiagram) with Mermaid inside
  `<figure class="diagram"><pre class="mermaid">...</pre><figcaption>...</figcaption></figure>`; add
  `erDiagram` / `stateDiagram-v2` for data models and lifecycles. Keep the syntax valid and write `<`
  as `&lt;` inside diagrams.
- No external stylesheets, fonts, images or scripts; keep the light color palette. The template's
  Mermaid loader (`<script data-hub-mermaid>`) is the one allowed script - keep it unchanged.

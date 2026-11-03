---
name: design-review
description: Checklist for reviewing technical design documents - problem fit, grounding in the codebase, correctness, non-functional requirements, trade-offs, risks and actionability. Use when reviewing a design.
---

# Reviewing a design document

Verify the document against the request and the actual repository; check that referenced code, APIs
and constraints exist and are described accurately.

## Checklist
- **Problem fit** - solves the stated request; goals and non-goals are explicit.
- **Grounding** - references real files, interfaces and constraints; no invented components.
- **Architecture fit** - consistent with existing patterns; no unnecessary new services or dependencies.
- **Correctness** - data flow, state transitions, ordering and error paths are consistent and defined.
- **Non-functional requirements** - performance, scalability, reliability, security/privacy and
  observability are addressed, with concrete targets where they matter.
- **Trade-offs** - alternatives considered and choices justified.
- **Risks** - failure modes, migration and backward compatibility, rollback.
- **Testability** - the testing plan covers the risky parts.
- **Actionability** - the implementation plan is ordered and specific enough to execute.

## Severity
- **blocker** - wrong, unsafe or infeasible; contradicts the request or the codebase.
- **major** - significant gap: missing failure handling, unaddressed requirement, unclear interfaces.
- **minor** - clarity or completeness improvement. **nit** - wording.

Approve when no blocker or major issue remains. On re-review, verify each previous comment against the
revision and the author's response.

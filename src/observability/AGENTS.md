# Observability Guide

This folder contains reusable telemetry helpers for Daimon runtime examples and
future callers.

## Structure

- `orgObserver.ts` records per-turn behavior, consultation edges, recall
  provenance, correctness assertions, and benchmark rows.
- `index.ts` exports the public observability helpers.
- `orgObserver.test.ts` covers behavior extraction without live engine calls.

## Rules

- Keep telemetry secret-safe by default. Store output excerpts and memory
  provenance, not raw credentials or hidden engine state.
- Observability must be engine-neutral. Do not import Pi, Grok, Agy, or Codex
  implementation details here.
- Keep generated runtime artifacts under the caller's ignored `.runtime/` tree.

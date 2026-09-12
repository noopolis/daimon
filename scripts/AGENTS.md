# Daimon Scripts Guide

This folder contains explicitly invoked operational scripts that exercise
Daimon against external runtimes. They are not part of the automated test
suite and must not embed credentials or override the production command path
unless a script's purpose explicitly requires that behavior.

Maintained scripts are TypeScript sources. Use `node --import tsx` for scripts
that import the repository source graph, because source imports may use emitted
`.js` specifiers that native strip-types does not resolve. Use
`node --experimental-strip-types` only for standalone builtin-only helpers.

The live Codex and Grok scripts spend provider quota and may read local
operator auth. Typecheck them, but do not add them to automated tests.

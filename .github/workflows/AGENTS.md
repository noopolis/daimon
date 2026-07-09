# Workflow Guide

This folder contains GitHub Actions workflows for Daimon.

## Rules

- CI must typecheck, test, and build the package.
- Release must verify the tag matches `package.json` before publishing.
- Keep workflow triggers narrow and intentional.

# Daimon MCP

This folder adapts Daimon's existing Pi `ToolDefinition` objects to MCP.

## Rules

- Do not implement or copy world or memory tools here; always delegate to the
  supplied `ToolDefinition.execute` function.
- The server is scoped to one wake and requires explicit tool-turn and deadline
  bounds. Both bounds are enforced before tool execution.
- MCP exposes each supplied Pi TypeBox/JSON-Schema `parameters` object verbatim and
  validates calls against that same object with a JSON-Schema validator. There is
  no schema conversion layer that can silently discard constraints.

# Grok headless result fixtures

`grok-streaming-messages-json-error-result.jsonl` was captured live on
2026-08-30 from `grok 1.0.13` (macOS arm64) with the exact flags production
uses (`--prompt-file … --output-format streaming-messages-json`). The turn
failed with `402 Payment Required — Grok Build usage balance exhausted`, which
is the incident this ledger exists to make visible, so it is a real
zero-filled-usage frame rather than a hand-written one.

The `system`/`init` frame's environment fields were sanitized before commit —
`cwd` is `/workspace` and `slash_commands`/`skills` are neutral placeholders —
because the live capture embedded the capturing operator's home path and their
personal skill install. The frame's structure is unchanged (same keys, same
non-empty string arrays), and the decoder reads none of those fields; only the
terminal `result` frame is verbatim.
`grokHeadlessTurnUsage.test.ts`'s "the captured fixtures carry no capturing
machine's environment" case keeps it that way.

It pins the field names the decoder reads:

    result.usage.input_tokens                  uncached prompt tokens only
    result.usage.output_tokens
    result.usage.cache_read_input_tokens
    result.usage.cache_creation_input_tokens
    result.num_turns
    result.total_cost_usd
    result.modelUsage                          `{}` when no per-model breakdown

`grok-streaming-messages-json-success-result.jsonl` is the success-subtype
`result` frame documented verbatim inside the same binary (`strings` over
`grok-1.0.13-macos-aarch64`, the "Output Formats › streaming-messages-json"
section), with the token buckets filled from the live measurement recorded in
`specs/USAGE_ACCOUNTING_DESIGN.md` in the Spawnfile repo. That document also states, normatively:

- `total_tokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`
- `usage.input_tokens` is **uncached only**; the three prompt-side buckets are disjoint
- `result.usage` "always emits numeric buckets, even when data is missing … Any
  bucket grok cannot account for falls back to `0`, because the Messages API
  schema has no marker for incomplete or absent usage. … Read an all-zero
  `usage` here as 'unknown', not 'free'."

That last point is why `complete` is a heuristic in this stream and not a read
signal: the `usage_is_incomplete` flag exists only in the `json` output format,
which production does not use.


# AGY headless result fixtures

`agy-stream-json-plain-result.jsonl` and `agy-stream-json-tool-result.jsonl`
were captured live on 2026-08-30 from the `agy` CLI (macOS arm64) with the
flags production uses (`--print … --output-format stream-json`, the second one
additionally `--dangerously-skip-permissions` with a throwaway stdio MCP server
registered through `agy mcp add`). Both are real turns, not hand-written
frames.

Sanitization before commit: the capturing operator's scratchpad path was
replaced with `/workspace`, the one absolute path inside a `view_file` tool
frame was rewritten under it, and the two `conversation_id` values were
replaced with fixed placeholders. Nothing the decoder reads was touched — the
terminal `result` frame's `status`, `response`, `num_turns` and `usage` are
verbatim. `agyHeadlessResult.test.ts`'s "the captured fixtures carry no
capturing machine's environment" case keeps it that way.

They pin the field names the decoder reads, and the two facts that make AGY's
envelope different from Grok's:

    result.status                              "SUCCESS", not subtype/is_error
    result.response                            the reply text
    result.num_turns
    result.usage.input_tokens
    result.usage.output_tokens
    result.usage.cache_read_tokens             NOT cache_read_input_tokens
    result.usage.thinking_tokens               a SUBSET of output_tokens
    result.usage.total_tokens                  cross-checked, not trusted

- There is no `cache_creation_input_tokens` and no `total_cost_usd`.
- The plain turn is `13,722 + 74 = 13,796 = total_tokens` while
  `thinking_tokens` is 73, which is the arithmetic proving reasoning tokens are
  already inside `output_tokens`.
- The tool turn's terminal `usage` (44,937 input) is the SUM over the turn's
  three model steps (14,579 + 15,079 + 15,279), not the last step's — so a
  decoder that read a `step_update` would under-report a tool-using wake by
  roughly threefold. One tool call against an empty-schema tool costs ~31k
  extra tokens of tool-use preamble.

#ifndef DAIMON_ENGINE_BROKER_LAUNCHER_H
#define DAIMON_ENGINE_BROKER_LAUNCHER_H
#include <stdint.h>

#define DBL_VERSION 2u
#define DBL_ORG_UID 2000u
#define DBL_BROKER_UID 2100u
#define DBL_MAX_PROMPT 65536u
#define DBL_MAX_TOKEN 4096u
#define DBL_MAX_CAPABILITY_BUNDLE (DBL_MAX_TOKEN * 2u + 4u)
/* The WHOLE turn's stdout, not one frame, and sized against real turns rather
   than headroom-by-guess. A live four-tool-call brokered turn emitted 26,482
   bytes, 23,320 of them one tool-result frame carrying four results
   (`.runtime/grok-p1b/worker-a2-output.jsonl`), so 64 KiB was reachable by an
   ordinary working turn: the nine-tool-call turn this was raised for lands
   around 210 KB of the same shape, and a trip costs the turn its whole text.
   The number is the control protocol's own `text` bound
   (`engineBrokerProtocol.ts`, 262144), because that is the next boundary the
   output must cross: a larger launcher bound would only move the refusal one
   layer up. A runaway worker is still stopped here — crossing it stops
   reading, SIGKILLs the worker's process group and reports `output_limit`. */
#define DBL_MAX_OUTPUT 262144u
/* Bounded tail of the worker's own merged stdout/stderr, kept only for a
   worker that exited on its own account (`DBL_STATUS_WORKER_FAILED`), so the
   reason reaches the host instead of `exit=1`. It is a diagnostic, never the
   turn's output: `output_length` stays 0 on every failure. */
#define DBL_MAX_DIAGNOSTIC 512u
/* The marker that joins the two ends of an elided diagnostic, byte-identical
   to the TypeScript window's (`boundedDiagnosticWindow` in
   `src/pi/cliChildOutput.ts`), so one grep finds every elision on either side
   of the boundary. Its own bytes are paid for out of DBL_MAX_DIAGNOSTIC. */
#define DBL_DIAGNOSTIC_ELISION "[\xe2\x80\xa6 %llu bytes elided \xe2\x80\xa6]"
#ifndef DBL_REGISTRY
#define DBL_REGISTRY "/etc/daimon-engine-broker/registrations.bin"
#endif
#ifndef DBL_SOCKET
#define DBL_SOCKET "/run/daimon-engine-broker/launcher.sock"
#endif
#define DBL_CONTROL_SOCKET "/run/daimon-engine-broker/control.sock"
#define DBL_BACKEND_SOCKET "/run/daimon-engine-broker/backend.sock"
#define DBL_MAX_CONTROL_FRAME 1048576u
#ifndef DBL_EXECUTABLE
#define DBL_EXECUTABLE "/usr/local/bin/grok"
#endif
/* Lean Grok worker contract; mirrored byte-for-byte by src/contracts/grokWorkerContract.ts
   and checked by launcherArgv.test.ts. */
#define DBL_GROK_SYSTEM_PROMPT                                                 \
  "You are a headless Daimon agent; no human is present. Your identity, instructions and wake event are in the user prompt. Daimon tools are MCP tools on server daimon: call a known one directly with use_tool (tool_name daimon__moltnet_read, daimon__moltnet_send, daimon__memory_search, daimon__memory_register, or another daimon__ name you were given); use search_tool only for a name you do not know. If a tool result says output was saved to a file, read that path with read_file. If a tool fails, do not retry it in a loop: stop and report the failure. Your final answer is a private note to the runtime: one line, or empty."
#define DBL_GROK_TOOLS "run_terminal_cmd,read_file,grep,list_dir,search_tool,use_tool"
#define DBL_GROK_MAX_TURNS "48"

struct dbl_request {
  uint32_t version, slot;
  char request_id[65], turn_id[65], agent_id[129], wake_id[129];
};
struct dbl_registration {
  uint32_t version, slot, uid, gid;
  char agent_id[129], workspace[256], home[256];
  uint8_t executable_sha256[32];
};
enum dbl_result_status {
  DBL_STATUS_OK = 0,
  DBL_STATUS_PRELAUNCH_FAILED = 1,
  DBL_STATUS_WORKER_FAILED = 2,
  DBL_STATUS_OUTPUT_FAILED = 3,
  DBL_STATUS_CANCELLED = 4
};
enum dbl_result_stage {
  DBL_STAGE_NONE = 0,
  DBL_STAGE_PEER = 1,
  DBL_STAGE_REQUEST = 2,
  DBL_STAGE_REGISTRATION = 3,
  DBL_STAGE_EXECUTABLE = 4,
  DBL_STAGE_EXEC = 5,
  DBL_STAGE_WAIT = 6,
  DBL_STAGE_OUTPUT = 7,
  DBL_STAGE_ATTESTATION = 8
};
enum dbl_failure_class {
  DBL_FAILURE_NONE = 0,
  DBL_FAILURE_PEER = 1,
  DBL_FAILURE_PROTOCOL = 2,
  DBL_FAILURE_REGISTRATION = 3,
  DBL_FAILURE_EXECUTABLE = 4,
  DBL_FAILURE_EXEC = 5,
  DBL_FAILURE_WAIT = 6,
  DBL_FAILURE_OUTPUT_LIMIT = 7,
  DBL_FAILURE_CANCELLED = 8,
  DBL_FAILURE_ATTESTATION_PROFILE_MISSING = 9,
  DBL_FAILURE_ATTESTATION_PROFILE_INVALID = 10
};
struct dbl_result {
  uint32_t version, status, worker_uid, output_length;
  int32_t worker_pid, exit_code, term_signal;
  uint64_t start_ticks;
  char turn_id[65];
  uint32_t stage, failure_class, profile_applied, diagnostic_length;
};
#define DBL_RESULT_SIZE 128u
#define DBL_RESULT_STAGE_OFFSET 108u
#define DBL_RESULT_FAILURE_CLASS_OFFSET 112u
#define DBL_RESULT_PROFILE_APPLIED_OFFSET 116u
#define DBL_RESULT_DIAGNOSTIC_LENGTH_OFFSET 120u
_Static_assert(sizeof(struct dbl_result) == DBL_RESULT_SIZE,
               "dbl_result ABI size");
_Static_assert(__builtin_offsetof(struct dbl_result, stage) ==
                   DBL_RESULT_STAGE_OFFSET,
               "dbl_result stage offset");
_Static_assert(__builtin_offsetof(struct dbl_result, failure_class) ==
                   DBL_RESULT_FAILURE_CLASS_OFFSET,
               "dbl_result failure offset");
_Static_assert(__builtin_offsetof(struct dbl_result, profile_applied) ==
                   DBL_RESULT_PROFILE_APPLIED_OFFSET,
               "dbl_result profile offset");
_Static_assert(__builtin_offsetof(struct dbl_result, diagnostic_length) ==
                   DBL_RESULT_DIAGNOSTIC_LENGTH_OFFSET,
               "dbl_result diagnostic length offset");

#endif

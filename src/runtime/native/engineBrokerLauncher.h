#ifndef DAIMON_ENGINE_BROKER_LAUNCHER_H
#define DAIMON_ENGINE_BROKER_LAUNCHER_H
#include <stdint.h>

#define DBL_VERSION 2u
#define DBL_ORG_UID 2000u
#define DBL_BROKER_UID 2100u
#define DBL_MAX_PROMPT 65536u
#define DBL_MAX_TOKEN 4096u
#define DBL_MAX_CAPABILITY_BUNDLE (DBL_MAX_TOKEN * 2u + 4u)
#define DBL_MAX_OUTPUT 65536u
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
  uint32_t stage, failure_class, profile_applied, reserved;
};
#define DBL_RESULT_SIZE 128u
#define DBL_RESULT_STAGE_OFFSET 108u
#define DBL_RESULT_FAILURE_CLASS_OFFSET 112u
#define DBL_RESULT_PROFILE_APPLIED_OFFSET 116u
#define DBL_RESULT_RESERVED_OFFSET 120u
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
_Static_assert(__builtin_offsetof(struct dbl_result, reserved) ==
                   DBL_RESULT_RESERVED_OFFSET,
               "dbl_result reserved offset");

#endif

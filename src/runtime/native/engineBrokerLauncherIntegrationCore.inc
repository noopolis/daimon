#define _GNU_SOURCE
#include "engineBrokerLauncher.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/sha.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static void check(int ok, const char *m) {
  if (!ok) {
    perror(m);
    exit(1);
  }
}
static int write_all(int fd, const void *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t n = write(fd, (const char *)bytes + offset, length - offset);
    if (n < 1)
      return 0;
    offset += (size_t)n;
  }
  return 1;
}
static int read_all(int fd, void *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t n = read(fd, (char *)bytes + offset, length - offset);
    if (n < 1)
      return 0;
    offset += (size_t)n;
  }
  return 1;
}
static int wait_bounded(pid_t pid, int *status) {
  for (int attempt = 0; attempt < 250; attempt++) {
    pid_t observed = waitpid(pid, status, WNOHANG);
    if (observed == pid)
      return 1;
    if (observed < 0)
      return 0;
    usleep(20000);
  }
  kill(pid, SIGKILL);
  waitpid(pid, status, 0);
  return 0;
}
static int result_padding_zero(const struct dbl_result *result) {
  const unsigned char *bytes = (const unsigned char *)result;
  const size_t padding[] = {28, 29, 30, 31, 105, 106, 107, 124, 125, 126, 127};
  for (size_t index = 0; index < sizeof(padding) / sizeof(padding[0]); index++)
    if (bytes[padding[index]] != 0)
      return 0;
  return 1;
}
static void wait_launcher_ready(pid_t pid) {
  for (int attempt = 0; attempt < 250; attempt++) {
    struct stat socket_identity;
    if (kill(pid, 0))
      break;
    if (!lstat(DBL_SOCKET, &socket_identity) &&
        S_ISSOCK(socket_identity.st_mode) && socket_identity.st_uid == 0 &&
        socket_identity.st_gid == DBL_BROKER_UID &&
        (socket_identity.st_mode & 0777) == 0660)
      return;
    usleep(20000);
  }
  check(0, "launcher readiness");
}
static void digest(const char *path, unsigned char out[32]) {
  int f = open(path, O_RDONLY);
  char b[4096];
  ssize_t n;
  SHA256_CTX c;
  check(f >= 0 && SHA256_Init(&c), "hash setup");
  while ((n = read(f, b, sizeof(b))) > 0)
    check(SHA256_Update(&c, b, (size_t)n), "hash update");
  check(n == 0 && SHA256_Final(out, &c), "hash final");
  close(f);
}
static int sealed(const char *value) {
  int f = memfd_create("broker-test", MFD_ALLOW_SEALING);
  check(f >= 0 && write(f, value, strlen(value)) == (ssize_t)strlen(value),
        "memfd");
  check(!fcntl(f, F_ADD_SEALS,
               F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL),
        "seal");
  lseek(f, 0, SEEK_SET);
  return f;
}
static size_t make_bundle(const char *provider, const char *mcp,
                          unsigned char bytes[DBL_MAX_CAPABILITY_BUNDLE]) {
  uint16_t p = (uint16_t)strlen(provider), m = (uint16_t)strlen(mcp);
  size_t n = 0;
  bytes[n++] = (unsigned char)p;
  bytes[n++] = (unsigned char)(p >> 8);
  memcpy(bytes + n, provider, p);
  n += p;
  bytes[n++] = (unsigned char)m;
  bytes[n++] = (unsigned char)(m >> 8);
  memcpy(bytes + n, mcp, m);
  return n + m;
}
static int sealed_bundle(const char *provider, const char *mcp) {
  unsigned char bytes[DBL_MAX_CAPABILITY_BUNDLE];
  size_t n = make_bundle(provider, mcp, bytes);
  int f = memfd_create("bundle", MFD_ALLOW_SEALING);
  check(f >= 0 && write_all(f, bytes, n), "bundle");
  check(!fcntl(f, F_ADD_SEALS,
               F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL),
        "bundle seal");
  lseek(f, 0, SEEK_SET);
  memset(bytes, 0, sizeof(bytes));
  return f;
}
static void send_request(int s, struct dbl_request *q, int p, int c) {
  char control[CMSG_SPACE(sizeof(int) * 2)] = {0};
  int f[2] = {p, c};
  struct iovec io = {q, sizeof(*q)};
  struct msghdr m = {.msg_iov = &io,
                     .msg_iovlen = 1,
                     .msg_control = control,
                     .msg_controllen = sizeof(control)};
  struct cmsghdr *h = CMSG_FIRSTHDR(&m);
  h->cmsg_level = SOL_SOCKET;
  h->cmsg_type = SCM_RIGHTS;
  h->cmsg_len = CMSG_LEN(sizeof(f));
  memcpy(CMSG_DATA(h), f, sizeof(f));
  check(sendmsg(s, &m, 0) == sizeof(*q), "sendmsg");
}
static void send_one(int s, struct dbl_request *q, int p) {
  char control[CMSG_SPACE(sizeof(int))] = {0};
  struct iovec io = {q, sizeof(*q)};
  struct msghdr m = {.msg_iov = &io,
                     .msg_iovlen = 1,
                     .msg_control = control,
                     .msg_controllen = sizeof(control)};
  struct cmsghdr *h = CMSG_FIRSTHDR(&m);
  h->cmsg_level = SOL_SOCKET;
  h->cmsg_type = SCM_RIGHTS;
  h->cmsg_len = CMSG_LEN(sizeof(p));
  memcpy(CMSG_DATA(h), &p, sizeof(p));
  check(sendmsg(s, &m, 0) == sizeof(*q), "send one");
}
static int connect_socket(void) {
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  strcpy(a.sun_path, DBL_SOCKET);
  check(s >= 0 && !connect(s, (void *)&a, sizeof(a)), "connect");
  return s;
}
static struct dbl_request request(void) {
  struct dbl_request q = {.version = DBL_VERSION, .slot = 7};
  strcpy(q.request_id, "request-1");
  strcpy(q.turn_id, "turn-1");
  strcpy(q.agent_id, "agent-1");
  strcpy(q.wake_id, "wake-1");
  return q;
}
static void client_case(void) {
  int input[2], output[2], status;
  check(!pipe(input) && !pipe(output), "client pipes");
  pid_t child = fork();
  if (!child) {
    dup2(input[0], 0);
    dup2(output[1], 1);
    close(input[1]);
    close(output[0]);
    execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker",
          "--client", NULL);
    _exit(127);
  }
  close(input[0]);
  close(output[1]);
  struct dbl_request request_value = request();
  uint32_t prompt_length = DBL_MAX_PROMPT;
  unsigned char capability[DBL_MAX_CAPABILITY_BUNDLE];
  uint32_t capability_length =
      (uint32_t)make_bundle("provider.Token-1", "mcp.Token-2", capability);
  char *prompt = malloc(prompt_length);
  memset(prompt, 'p', prompt_length);
  check(write(input[1], &request_value, sizeof(request_value)) ==
                sizeof(request_value) &&
            write(input[1], &prompt_length, sizeof(prompt_length)) ==
                sizeof(prompt_length) &&
            write_all(input[1], prompt, prompt_length) &&
            write(input[1], &capability_length, sizeof(capability_length)) ==
                sizeof(capability_length) &&
            write_all(input[1], capability, capability_length),
        "client frame");
  memset(prompt, 0, prompt_length);
  free(prompt);
  close(input[1]);
  struct dbl_result result;
  ssize_t result_bytes = read(output[0], &result, sizeof(result));
  if (result_bytes == (ssize_t)sizeof(result) &&
      (result.status != DBL_STATUS_OK || result.stage != DBL_STAGE_OUTPUT))
    fprintf(stderr,
            "diagnostic status=%u stage=%u class=%u exit=%d signal=%d pid=%d "
            "uid=%u ticks=%llu bytes=%u\n",
            result.status, result.stage, result.failure_class, result.exit_code,
            result.term_signal, result.worker_pid, result.worker_uid,
            (unsigned long long)result.start_ticks, result.output_length);
  check(
      result_bytes == sizeof(result) && result_padding_zero(&result) &&
          result.status == DBL_STATUS_OK && result.stage == DBL_STAGE_OUTPUT &&
          result.failure_class == DBL_FAILURE_NONE && !result.profile_applied &&
          !result.reserved && result.output_length < DBL_MAX_OUTPUT,
      "client result");
  char *out = calloc(1, result.output_length + 1);
  check(read(output[0], out, result.output_length) ==
            (ssize_t)result.output_length,
        "client output");
  if (!strstr(out, "uid=2200") || strstr(out, "provider.Token-1") ||
      strstr(out, "mcp.Token-2")) {
    fprintf(stderr, "worker status=%u exit=%d signal=%d bytes=%u\n",
            result.status, result.exit_code, result.term_signal,
            result.output_length);
    check(0, "client secrecy");
  }
  check(read(output[0], out, 1) == 0, "client exact output");
  free(out);
  close(output[0]);
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "client status");
}
static void client_input_reject(uint32_t claimed, size_t supplied) {
  int input[2], output[2], status;
  check(!pipe(input) && !pipe(output), "reject pipes");
  pid_t child = fork();
  if (!child) {
    dup2(input[0], 0);
    dup2(output[1], 1);
    close(input[1]);
    close(output[0]);
    execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker",
          "--client", NULL);
    _exit(127);
  }
  close(input[0]);
  close(output[1]);
  struct dbl_request value = request();
  write(input[1], &value, sizeof(value));
  write(input[1], &claimed, sizeof(claimed));
  if (supplied)
    write(input[1], "x", supplied);
  close(input[1]);
  char byte;
  check(read(output[0], &byte, 1) == 0, "rejected client silence");
  close(output[0]);
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 111,
        "client input rejection");
}
static void auth_reject(uid_t uid, int fd, int extra) {
  int output[2], errors[2], status;
  check(!pipe(output) && !pipe(errors), "auth pipes");
  pid_t child = fork();
  if (!child) {
    if (uid) {
      setgid(uid);
      setuid(uid);
    }
    dup2(fd, 4);
    dup2(output[1], 1);
    dup2(errors[1], 2);
    close(output[0]);
    close(errors[0]);
    if (extra)
      execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker",
            "--auth-provider", "override", NULL);
    else
      execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker",
            "--auth-provider", NULL);
    _exit(127);
  }
  close(output[1]);
  close(errors[1]);
  char byte;
  check(read(output[0], &byte, 1) == 0 && read(errors[0], &byte, 1) == 0,
        "auth failure silence");
  close(output[0]);
  close(errors[0]);
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 111, "auth rejection");
}
static void auth_adversarial_cases(void) {
  int good = sealed_bundle("opaque.Token-1", "mcp.Token-2");
  auth_reject(0, good, 0);
  auth_reject(2200, good, 1);
  int unsealed = memfd_create("unsealed", MFD_ALLOW_SEALING);
  write(unsealed, "token", 5);
  auth_reject(2200, unsealed, 0);
  int oversized = memfd_create("oversized", MFD_ALLOW_SEALING);
  char bytes[DBL_MAX_CAPABILITY_BUNDLE + 1];
  memset(bytes, 'a', sizeof(bytes));
  write(oversized, bytes, sizeof(bytes));
  fcntl(oversized, F_ADD_SEALS,
        F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL);
  auth_reject(2200, oversized, 0);
  int malformed = sealed_bundle("same.Token", "same.Token");
  auth_reject(2200, malformed, 0);
  int badlength = memfd_create("badlength", MFD_ALLOW_SEALING);
  unsigned char bad[] = {5, 0, 'a', 'b', 1, 0, 'c'};
  write(badlength, bad, sizeof(bad));
  fcntl(badlength, F_ADD_SEALS,
        F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL);
  auth_reject(2200, badlength, 0);
  memset(bytes, 0, sizeof(bytes));
  memset(bad, 0, sizeof(bad));
  close(good);
  close(unsealed);
  close(oversized);
  close(malformed);
  close(badlength);
}
static void malformed_response_case(int truncated) {
  unlink(DBL_SOCKET);
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  strcpy(a.sun_path, DBL_SOCKET);
  check(server >= 0 && !bind(server, (void *)&a, sizeof(a)) &&
            !chmod(DBL_SOCKET, 0777) && !listen(server, 1),
        "fake server");
  int input[2], output[2];
  check(!pipe(input) && !pipe(output), "fake pipes");
  pid_t child = fork();
  if (!child) {
    setgid(DBL_BROKER_UID);
    setuid(DBL_BROKER_UID);
    dup2(input[0], 0);
    dup2(output[1], 1);
    close(input[1]);
    close(output[0]);
    execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker",
          "--client", NULL);
    _exit(127);
  }
  close(input[0]);
  close(output[1]);
  struct dbl_request request_value = request();
  uint32_t one = 1;
  write(input[1], &request_value, sizeof(request_value));
  write(input[1], &one, sizeof(one));
  write(input[1], "p", 1);
  write(input[1], &one, sizeof(one));
  write(input[1], "c", 1);
  close(input[1]);
  int peer = accept(server, NULL, NULL);
  char inbound[sizeof(struct dbl_request)];
  recv(peer, inbound, sizeof(inbound), 0);
  struct dbl_result result = {.version = DBL_VERSION,
                              .status = DBL_STATUS_OK,
                              .worker_uid = 2200,
                              .worker_pid = 42,
                              .start_ticks = 1,
                              .stage = DBL_STAGE_OUTPUT};
  memcpy(result.turn_id, "turn-1", 7);
  if (truncated)
    write(peer, &result, sizeof(result) / 2);
  else {
    result.reserved = 1;
    write(peer, &result, sizeof(result));
  }
  close(peer);
  close(server);
  struct dbl_result observed;
  check(read(output[0], &observed, sizeof(observed)) == sizeof(observed) &&
            result_padding_zero(&observed) &&
            observed.status == DBL_STATUS_PRELAUNCH_FAILED &&
            observed.stage == DBL_STAGE_REQUEST &&
            observed.failure_class == DBL_FAILURE_PROTOCOL &&
            !observed.reserved,
        "fixed protocol diagnostic");
  close(output[0]);
  int status;
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        truncated ? "truncated result" : "reserved result");
}

#define _GNU_SOURCE
#include "engineBrokerLauncher.h"
#include <arpa/inet.h>
#include <dirent.h>
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
#include <time.h>
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
/* The launcher handler supervising the current worker, and its CPU burn. The
   handler is the worker's parent; a handler waiting in poll() burns nothing,
   and one spinning on a ready descriptor burns a core. That difference is the
   only observable that separates a fixed launcher from a wedged one while the
   worker is still alive, so it is what the spin case asserts on. */
static pid_t worker_handler_pid(uid_t uid) {
  DIR *proc = opendir("/proc");
  struct dirent *entry;
  pid_t handler = -1;
  check(proc != NULL, "scan /proc for the worker");
  while ((entry = readdir(proc))) {
    char path[64], status[512], *cursor;
    unsigned long long real = 0;
    long pid = strtol(entry->d_name, &cursor, 10), parent = -1;
    int fd;
    ssize_t n;
    if (*cursor || pid < 2)
      continue;
    snprintf(path, sizeof(path), "/proc/%ld/status", pid);
    fd = open(path, O_RDONLY);
    if (fd < 0)
      continue;
    n = read(fd, status, sizeof(status) - 1);
    close(fd);
    if (n < 1)
      continue;
    status[n] = 0;
    cursor = strstr(status, "\nUid:");
    if (!cursor || sscanf(cursor + 5, "%llu", &real) != 1 || real != uid)
      continue;
    cursor = strstr(status, "\nPPid:");
    if (cursor && sscanf(cursor + 6, "%ld", &parent) == 1 && parent > 1)
      handler = (pid_t)parent;
  }
  closedir(proc);
  return handler;
}
static unsigned long process_cpu_ticks(pid_t pid) {
  char path[64], buffer[1024], *cursor;
  unsigned long utime = 0, stime = 0;
  unsigned field = 3;
  int fd;
  ssize_t n;
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  fd = open(path, O_RDONLY);
  if (fd < 0)
    return 0;
  n = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);
  if (n < 1)
    return 0;
  buffer[n] = 0;
  cursor = strrchr(buffer, ')');
  if (!cursor)
    return 0;
  for (cursor += 2; *cursor; cursor++) {
    if (*cursor == ' ')
      field++;
    if (field == 14 && utime == 0)
      utime = strtoul(cursor, NULL, 10);
    if (field == 15) {
      stime = strtoul(cursor, NULL, 10);
      break;
    }
  }
  return utime + stime;
}
/* How many processes the worker identity still owns, in ANY state. A
   killed-but-unreaped `<defunct>` counts: it is still a `bwrap` or a `grok` to
   anything matching on process names, and a process-name match is exactly what
   the organization's pre-run gate read as work in flight. Read from `status`
   rather than from the directory owner, which follows the effective uid alone. */
static int worker_identity_processes(uid_t uid) {
  DIR *proc = opendir("/proc");
  struct dirent *entry;
  int owned = 0;
  check(proc != NULL, "scan /proc");
  while ((entry = readdir(proc))) {
    char path[64], status[512], *cursor;
    unsigned long long real = 0, effective = 0, saved = 0;
    long pid = strtol(entry->d_name, &cursor, 10);
    int fd;
    ssize_t n;
    if (*cursor || pid < 2)
      continue;
    snprintf(path, sizeof(path), "/proc/%ld/status", pid);
    fd = open(path, O_RDONLY);
    if (fd < 0)
      continue;
    n = read(fd, status, sizeof(status) - 1);
    close(fd);
    if (n < 1)
      continue;
    status[n] = 0;
    cursor = strstr(status, "\nUid:");
    if (!cursor ||
        sscanf(cursor + 5, "%llu %llu %llu", &real, &effective, &saved) != 3)
      continue;
    if (real == uid || effective == uid || saved == uid)
      owned++;
  }
  closedir(proc);
  return owned;
}
/* The launcher reaps before it writes the result frame, so a turn that has
   answered has already settled; the poll is only for the cancelled path, which
   answers nothing. Two seconds is far past a SIGKILL that is not refusable. */
static void check_worker_identity_settled(uid_t uid, const char *label) {
  for (int attempt = 0; attempt < 100; attempt++) {
    if (worker_identity_processes(uid) == 0)
      return;
    usleep(20000);
  }
  fprintf(stderr, "%s: uid %u still owns %d process(es)\n", label, uid,
          worker_identity_processes(uid));
  check(0, label);
}
/* Where the escapee recorded itself. Proves the case actually produced a
   process outside the worker's group and session, so a settled uid cannot be a
   turn that escaped nothing. */
static void read_escape_marker(const char *provider, long *pid, long *group,
                               long *session) {
  char path[128];
  snprintf(path, sizeof(path), "/tmp/worker-%s", provider);
  for (int attempt = 0; attempt < 250; attempt++) {
    FILE *marker = fopen(path, "r");
    if (marker) {
      int fields = fscanf(marker, "%ld %ld %ld", pid, group, session);
      fclose(marker);
      if (fields == 3)
        return;
    }
    usleep(20000);
  }
  check(0, "worker escape marker");
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
          !result.diagnostic_length && result.output_length < DBL_MAX_OUTPUT,
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
    result.diagnostic_length = DBL_MAX_DIAGNOSTIC + 1;
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
            !observed.diagnostic_length,
        "fixed protocol diagnostic");
  close(output[0]);
  int status;
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        truncated ? "truncated result" : "over-bound diagnostic result");
}

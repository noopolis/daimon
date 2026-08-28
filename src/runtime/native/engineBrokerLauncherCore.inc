#define _GNU_SOURCE
#include "engineBrokerLauncher.h"
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <linux/prctl.h>
#include <openssl/sha.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/poll.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static __attribute__((noreturn)) void die(void) { _exit(111); }
static int bounded(const char *s, size_t n) { return memchr(s, 0, n) != NULL; }
static int safe_component(const char *s, size_t n) {
  size_t i, l = strnlen(s, n);
  if (!l || l == n)
    return 0;
  for (i = 0; i < l; i++)
    if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z') ||
          (s[i] >= '0' && s[i] <= '9') || s[i] == '-' || s[i] == '_' ||
          s[i] == ':' || s[i] == '.'))
      return 0;
  return 1;
}
static int full_read(int fd, void *buf, size_t n) {
  size_t o = 0;
  ssize_t r;
  while (o < n) {
    r = read(fd, (char *)buf + o, n - o);
    if (r < 1)
      return -1;
    o += (size_t)r;
  }
  return 0;
}
static int full_write(int fd, const void *buf, size_t n) {
  size_t o = 0;
  ssize_t r;
  while (o < n) {
    r = write(fd, (const char *)buf + o, n - o);
    if (r < 1)
      return -1;
    o += (size_t)r;
  }
  return 0;
}
static void erase(void *value, size_t n) {
  volatile unsigned char *p = value;
  while (n--)
    *p++ = 0;
}

static int receive_request(int fd, struct dbl_request *r, int passed[2]) {
  char control[CMSG_SPACE(sizeof(int) * 2)];
  struct iovec io = {r, sizeof(*r)};
  struct msghdr m = {0};
  struct cmsghdr *c;
  ssize_t n;
  memset(control, 0, sizeof(control));
  m.msg_iov = &io;
  m.msg_iovlen = 1;
  m.msg_control = control;
  m.msg_controllen = sizeof(control);
  n = recvmsg(fd, &m, MSG_CMSG_CLOEXEC | MSG_WAITALL);
  if (n != (ssize_t)sizeof(*r) || m.msg_flags & (MSG_TRUNC | MSG_CTRUNC))
    return -1;
  c = CMSG_FIRSTHDR(&m);
  if (!c || CMSG_NXTHDR(&m, c) || c->cmsg_level != SOL_SOCKET ||
      c->cmsg_type != SCM_RIGHTS || c->cmsg_len != CMSG_LEN(sizeof(int) * 2))
    return -1;
  memcpy(passed, CMSG_DATA(c), sizeof(int) * 2);
  return 0;
}

static int sealed_regular(int fd, size_t maximum) {
  struct stat s;
  int seals;
  if (fstat(fd, &s) || !S_ISREG(s.st_mode) || s.st_size < 1 ||
      (uint64_t)s.st_size > maximum)
    return 0;
  seals = fcntl(fd, F_GET_SEALS);
  return seals >= 0 && (seals & (F_SEAL_WRITE | F_SEAL_SHRINK | F_SEAL_GROW)) ==
                           (F_SEAL_WRITE | F_SEAL_SHRINK | F_SEAL_GROW);
}
static int valid_token(const unsigned char *value, size_t length) {
  if (!length || length > DBL_MAX_TOKEN)
    return 0;
  for (size_t i = 0; i < length; i++)
    if (!((value[i] >= 'A' && value[i] <= 'Z') ||
          (value[i] >= 'a' && value[i] <= 'z') ||
          (value[i] >= '0' && value[i] <= '9') || value[i] == '.' ||
          value[i] == '_' || value[i] == '~' || value[i] == '-'))
      return 0;
  return 1;
}
static int capability_bundle(int fd, unsigned char provider[DBL_MAX_TOKEN + 1],
                             unsigned char mcp[DBL_MAX_TOKEN + 1]) {
  unsigned char bytes[DBL_MAX_CAPABILITY_BUNDLE] = {0};
  struct stat s;
  size_t offset = 0;
  uint16_t provider_length, mcp_length;
  int ok = -1;
  if (!sealed_regular(fd, DBL_MAX_CAPABILITY_BUNDLE) || fstat(fd, &s) ||
      pread(fd, bytes, (size_t)s.st_size + 1, 0) != s.st_size ||
      (size_t)s.st_size < 6)
    goto done;
  provider_length = (uint16_t)(bytes[0] | ((uint16_t)bytes[1] << 8));
  offset = 2;
  if (!valid_token(bytes + offset, provider_length) ||
      offset + provider_length + 2 > (size_t)s.st_size)
    goto done;
  if (provider)
    memcpy(provider, bytes + offset, provider_length);
  offset += provider_length;
  mcp_length = (uint16_t)(bytes[offset] | ((uint16_t)bytes[offset + 1] << 8));
  offset += 2;
  if (!valid_token(bytes + offset, mcp_length) ||
      offset + mcp_length != (size_t)s.st_size ||
      (provider_length == mcp_length &&
       !memcmp(bytes + 2, bytes + offset, mcp_length)))
    goto done;
  if (mcp)
    memcpy(mcp, bytes + offset, mcp_length);
  ok = 0;
done:
  erase(bytes, sizeof(bytes));
  return ok;
}
static int load_registration(uint32_t slot, struct dbl_registration *out) {
  int fd = open(DBL_REGISTRY, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat s;
  struct dbl_registration r;
  if (fd < 0 || fstat(fd, &s) || !S_ISREG(s.st_mode) || s.st_uid != 0 ||
      (s.st_mode & 022) != 0)
    return -1;
  while (full_read(fd, &r, sizeof(r)) == 0)
    if (r.version == DBL_VERSION && r.slot == slot) {
      *out = r;
      close(fd);
      return 0;
    }
  close(fd);
  return -1;
}
static int valid_registration(const struct dbl_registration *r,
                              const struct dbl_request *q) {
  return r->uid >= 2200 && r->gid >= 2200 &&
         bounded(r->workspace, sizeof(r->workspace)) &&
         bounded(r->home, sizeof(r->home)) && r->workspace[0] == '/' &&
         r->home[0] == '/' &&
         safe_component(r->agent_id, sizeof(r->agent_id)) &&
         strcmp(r->agent_id, q->agent_id) == 0;
}
static void close_other_fds(int keep) {
  long max = sysconf(_SC_OPEN_MAX);
  int fd;
  for (fd = 3; fd < (max > 65536 ? 65536 : (int)max); fd++)
    if (fd != 3 && fd != 4 && fd != 5 && fd != keep)
      close(fd);
}
static void zero_caps(void) {
  struct __user_cap_header_struct h = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct d[2] = {{0}};
  if (!syscall(SYS_capset, &h, d))
    return;
  memset(d, 0, sizeof(d));
  if (syscall(SYS_capget, &h, d) || d[0].effective || d[0].permitted ||
      d[0].inheritable || d[1].effective || d[1].permitted || d[1].inheritable)
    die();
}
static void drop_bounding_caps(void) {
  int cap;
  for (cap = 0; cap < 256; cap++) {
    int present = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (present < 0) {
      if (errno == EINVAL)
        break;
      die();
    }
    if (present && prctl(PR_CAPBSET_DROP, cap, 0, 0, 0))
      die();
  }
  if (cap == 256)
    die();
  for (int verify = 0; verify < cap; verify++)
    if (prctl(PR_CAPBSET_READ, verify, 0, 0, 0) != 0)
      die();
}
static int executable_fd(const struct dbl_registration *r) {
  int fd = open(DBL_EXECUTABLE, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat s;
  SHA256_CTX ctx;
  unsigned char digest[32], buf[8192];
  ssize_t n;
  if (fd < 0 || fstat(fd, &s) || !S_ISREG(s.st_mode) || s.st_uid != 0 ||
      (s.st_mode & 022) || !(s.st_mode & 0111) || !SHA256_Init(&ctx))
    goto bad;
  while ((n = read(fd, buf, sizeof(buf))) > 0)
    if (!SHA256_Update(&ctx, buf, (size_t)n))
      goto bad;
  if (n < 0 || !SHA256_Final(digest, &ctx) ||
      memcmp(digest, r->executable_sha256, sizeof(digest)) ||
      lseek(fd, 0, SEEK_SET) < 0)
    goto bad;
  return fd;
bad:
  if (fd >= 0)
    close(fd);
  return -1;
}
static uint64_t start_ticks(pid_t pid) {
  char p[64], b[1024], *x;
  int fd;
  ssize_t n;
  unsigned field = 3;
  snprintf(p, sizeof(p), "/proc/%ld/stat", (long)pid);
  fd = open(p, O_RDONLY | O_CLOEXEC);
  if (fd < 0)
    return 0;
  n = read(fd, b, sizeof(b) - 1);
  close(fd);
  if (n < 1)
    return 0;
  b[n] = 0;
  x = strrchr(b, ')');
  if (!x)
    return 0;
  for (x += 2; *x; x++) {
    if (*x == ' ')
      field++;
    if (field == 22)
      return strtoull(x, NULL, 10);
  }
  return 0;
}

static __attribute__((noreturn)) void launch_fail(int status_fd,
                                                  uint32_t code) {
  (void)full_write(status_fd, &code, sizeof(code));
  _exit(111);
}
static pid_t launch(const struct dbl_registration *r, int executable,
                    int prompt, int capability, int output, uint32_t *failure,
                    uint64_t *observed_start_ticks) {
  unsigned char mcp[DBL_MAX_TOKEN + 1] = {0};
  int status_pipe[2];
  if (capability_bundle(capability, NULL, mcp) || pipe2(status_pipe, O_CLOEXEC))
    return -1;
  pid_t p = fork();
  if (p < 0) {
    close(status_pipe[0]);
    close(status_pipe[1]);
    erase(mcp, sizeof(mcp));
    return -1;
  }
  if (p != 0) {
    uint32_t code = 0;
    close(status_pipe[1]);
    if (full_read(status_pipe[0], observed_start_ticks,
                  sizeof(*observed_start_ticks)) ||
        !*observed_start_ticks) {
      close(status_pipe[0]);
      erase(mcp, sizeof(mcp));
      kill(p, SIGKILL);
      waitpid(p, NULL, 0);
      return -1;
    }
    ssize_t got = read(status_pipe[0], &code, sizeof(code));
    close(status_pipe[0]);
    erase(mcp, sizeof(mcp));
    if (got == 0)
      return p;
    if (got == (ssize_t)sizeof(code))
      *failure = code;
    kill(p, SIGKILL);
    waitpid(p, NULL, 0);
    return -1;
  }
  close(status_pipe[0]);
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() == 1 || setpgid(0, 0))
    launch_fail(status_pipe[1], 1);
  uint64_t identity = start_ticks(getpid());
  if (!identity || full_write(status_pipe[1], &identity, sizeof(identity)))
    launch_fail(status_pipe[1], 1);
  struct rlimit z = {0, 0};
  if (setrlimit(RLIMIT_CORE, &z) || setgroups(0, NULL) ||
      prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0) || setresgid(r->gid, r->gid, r->gid) ||
      setresuid(r->uid, r->uid, r->uid))
    launch_fail(status_pipe[1], 2);
  zero_caps();
  if (prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))
    launch_fail(status_pipe[1], 3);
  if (dup2(prompt, 3) < 0 || dup2(capability, 4) < 0 ||
      dup2(output, STDOUT_FILENO) < 0 || dup2(output, STDERR_FILENO) < 0)
    launch_fail(status_pipe[1], 4);
  if (executable != 5 && dup2(executable, 5) < 0)
    launch_fail(status_pipe[1], 5);
  close_other_fds(status_pipe[1]);
  char *const argv[] = {"grok",
                        "--sandbox",
                        "daimon-strict",
                        "--always-approve",
                        "--no-subagents",
                        "--prompt-file",
                        "/proc/self/fd/3",
                        "--no-memory",
                        "--disable-web-search",
                        "--cwd",
                        (char *)r->workspace,
                        "--output-format",
                        "streaming-messages-json",
                        "--model",
                        "daimon-broker-grok",
                        NULL};
  char home[300], grok[300], mcp_env[DBL_MAX_TOKEN + 24];
  snprintf(home, sizeof(home), "HOME=%s", r->home);
  snprintf(grok, sizeof(grok), "GROK_HOME=%s/.grok", r->home);
  snprintf(mcp_env, sizeof(mcp_env), "DAIMON_MCP_CAPABILITY=%s", mcp);
  erase(mcp, sizeof(mcp));
  char *const envp[] = {home,
                        grok,
                        mcp_env,
                        "DAIMON_CAPABILITY_FD=4",
                        "PATH=/usr/local/bin:/usr/bin:/bin",
                        "LANG=C.UTF-8",
                        "TZ=UTC",
                        NULL};
  syscall(SYS_execveat, 5, "", argv, envp, AT_EMPTY_PATH);
  erase(mcp_env, sizeof(mcp_env));
  launch_fail(status_pipe[1], 6);
}

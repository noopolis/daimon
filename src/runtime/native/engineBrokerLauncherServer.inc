static __attribute__((noreturn)) void launch_fail(int status_fd,
                                                  uint32_t code) {
  (void)full_write(status_fd, &code, sizeof(code));
  _exit(111);
}
static pid_t launch(const struct dbl_registration *r, int executable,
                    int prompt, int capability, int output, uint32_t *failure,
                    uint64_t *observed_start_ticks) {
  unsigned char provider[DBL_MAX_TOKEN + 1] = {0}, mcp[DBL_MAX_TOKEN + 1] = {0};
  int status_pipe[2];
  if (capability_bundle(capability, provider, mcp) ||
      pipe2(status_pipe, O_CLOEXEC)) {
    erase(provider, sizeof(provider));
    erase(mcp, sizeof(mcp));
    return -1;
  }
  pid_t p = fork();
  if (p < 0) {
    close(status_pipe[0]);
    close(status_pipe[1]);
    erase(provider, sizeof(provider));
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
      erase(provider, sizeof(provider));
      erase(mcp, sizeof(mcp));
      kill(p, SIGKILL);
      waitpid(p, NULL, 0);
      return -1;
    }
    ssize_t got = read(status_pipe[0], &code, sizeof(code));
    close(status_pipe[0]);
    erase(provider, sizeof(provider));
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
  /* Received fds carry MSG_CMSG_CLOEXEC and may already sit on 3-5: dup2 onto
     itself keeps close-on-exec (the prompt vanished at exec) and an
     overlapping order clobbers a source. Lift all of them above the targets
     first so every dup2 below changes the fd number and clears CLOEXEC. */
  int status_fd = fcntl(status_pipe[1], F_DUPFD_CLOEXEC, 16);
  if (status_fd < 0)
    launch_fail(status_pipe[1], 4);
  int null_input = open("/dev/null", O_RDONLY | O_CLOEXEC);
  int high_prompt = fcntl(prompt, F_DUPFD_CLOEXEC, 16),
      high_capability = fcntl(capability, F_DUPFD_CLOEXEC, 16),
      high_output = fcntl(output, F_DUPFD_CLOEXEC, 16),
      high_executable = fcntl(executable, F_DUPFD_CLOEXEC, 16);
  if (null_input < 0 || high_prompt < 0 || high_capability < 0 ||
      high_output < 0 || high_executable < 0 ||
      dup2(null_input, STDIN_FILENO) < 0 || dup2(high_prompt, 3) < 0 ||
      dup2(high_capability, 4) < 0 || dup2(high_output, STDOUT_FILENO) < 0 ||
      dup2(high_output, STDERR_FILENO) < 0)
    launch_fail(status_fd, 4);
  /* The worker needs fd 5 only to be executed: close-on-exec keeps the Grok
     image descriptor out of the worker and every tool child (execveat with
     AT_EMPTY_PATH still works for an ELF; only a #! script would lose it). */
  if (dup2(high_executable, 5) < 0 || fcntl(5, F_SETFD, FD_CLOEXEC) < 0)
    launch_fail(status_fd, 5);
  close_other_fds(status_fd);
  char *const argv[] = {"grok",
                        "--sandbox",
                        "daimon-strict",
                        "--always-approve",
                        "--no-subagents",
                        "--prompt-file",
                        "/proc/self/fd/3",
                        "--no-memory",
                        "--disable-web-search",
                        "--no-plan",
                        "--verbatim",
                        "--system-prompt-override",
                        DBL_GROK_SYSTEM_PROMPT,
                        "--tools",
                        DBL_GROK_TOOLS,
                        "--max-turns",
                        DBL_GROK_MAX_TURNS,
                        "--cwd",
                        (char *)r->workspace,
                        "--output-format",
                        "streaming-messages-json",
                        "--model",
                        "daimon-broker-grok",
                        NULL};
  char home[300], grok[300], tmp[300], mcp_env[DBL_MAX_TOKEN + 24],
       provider_env[DBL_MAX_TOKEN + 32];
  /* Worker-private temp: strict grants TMPDIR read-write, and shared /tmp is
     kept from the worker by the deployment's modes (attested by the broker).
     A truncated path must never name a different directory: fail instead. */
  if ((size_t)snprintf(home, sizeof(home), "HOME=%s", r->home) >= sizeof(home) ||
      (size_t)snprintf(grok, sizeof(grok), "GROK_HOME=%s/.grok", r->home) >=
          sizeof(grok) ||
      (size_t)snprintf(tmp, sizeof(tmp), "TMPDIR=%s/tmp", r->home) >=
          sizeof(tmp)) {
    erase(provider, sizeof(provider));
    erase(mcp, sizeof(mcp));
    launch_fail(status_fd, 6);
  }
  snprintf(mcp_env, sizeof(mcp_env), "DAIMON_MCP_CAPABILITY=%s", mcp);
  /* Grok 1.0.34 never runs `[auth_provider.*]` helpers for a custom model, so
     the worker's `[model.daimon-broker-grok] env_key` reads the turn-scoped
     proxy capability from here. It is as exposed as the MCP capability. */
  snprintf(provider_env, sizeof(provider_env), "DAIMON_PROVIDER_CAPABILITY=%s",
           provider);
  erase(provider, sizeof(provider));
  erase(mcp, sizeof(mcp));
  char *const envp[] = {home,
                        grok,
                        tmp,
                        mcp_env,
                        provider_env,
                        "DAIMON_CAPABILITY_FD=4",
                        "PATH=/usr/local/bin:/usr/bin:/bin",
                        "LANG=C.UTF-8",
                        "TZ=UTC",
                        NULL};
  syscall(SYS_execveat, 5, "", argv, envp, AT_EMPTY_PATH);
  erase(provider_env, sizeof(provider_env));
  erase(mcp_env, sizeof(mcp_env));
  launch_fail(status_fd, 6);
}

static void supervise(int client, pid_t pid, int output,
                      struct dbl_result *out) {
  unsigned char bytes[DBL_MAX_OUTPUT + 1] = {0};
  size_t used = 0;
  int status = 0, done = 0, disconnected = 0, output_limited = 0,
      wait_failed = 0;
  struct pollfd p[2] = {{client, POLLIN | POLLHUP | POLLERR, 0},
                        {output, POLLIN | POLLHUP | POLLERR, 0}};
  while (!done) {
    int n = poll(p, 2, 250);
    if (n < 0 && errno != EINTR) {
      disconnected = 1;
      wait_failed = 1;
    }
    if (p[0].revents & (POLLHUP | POLLERR))
      disconnected = 1;
    if (p[0].revents & POLLIN) {
      char b;
      (void)recv(client, &b, 1, MSG_PEEK | MSG_DONTWAIT);
      disconnected = 1;
    }
    if (p[1].revents & POLLIN) {
      ssize_t got = read(output, bytes + used, sizeof(bytes) - used);
      if (got > 0)
        used += (size_t)got;
      if (used > DBL_MAX_OUTPUT) {
        output_limited = 1;
        p[1].events = 0;
        out->status = DBL_STATUS_OUTPUT_FAILED;
        out->stage = DBL_STAGE_OUTPUT;
        out->failure_class = DBL_FAILURE_OUTPUT_LIMIT;
      }
    }
    if (disconnected || output_limited)
      kill(-pid, SIGKILL);
    pid_t w = waitpid(pid, &status, WNOHANG);
    if (w == pid)
      done = 1;
    else if (w < 0 && errno != EINTR) {
      done = 1;
      wait_failed = 1;
    }
  }
  kill(-pid, SIGKILL);
  while (!output_limited && used < sizeof(bytes)) {
    ssize_t got = read(output, bytes + used, sizeof(bytes) - used);
    if (got <= 0)
      break;
    used += (size_t)got;
  }
  if (WIFEXITED(status))
    out->exit_code = WEXITSTATUS(status);
  else if (WIFSIGNALED(status))
    out->term_signal = WTERMSIG(status);
  if (output_limited) {
    out->status = DBL_STATUS_OUTPUT_FAILED;
    out->stage = DBL_STAGE_OUTPUT;
    out->failure_class = DBL_FAILURE_OUTPUT_LIMIT;
  } else if (wait_failed) {
    out->status = DBL_STATUS_WORKER_FAILED;
    out->stage = DBL_STAGE_WAIT;
    out->failure_class = DBL_FAILURE_WAIT;
  } else if (disconnected) {
    out->status = DBL_STATUS_CANCELLED;
    out->stage = DBL_STAGE_WAIT;
    out->failure_class = DBL_FAILURE_CANCELLED;
  } else if (out->exit_code != 0 || out->term_signal != 0) {
    out->status = DBL_STATUS_WORKER_FAILED;
    out->stage = DBL_STAGE_WAIT;
    out->failure_class = DBL_FAILURE_EXEC;
  } else {
    out->status = DBL_STATUS_OK;
    out->stage = DBL_STAGE_OUTPUT;
    out->failure_class = DBL_FAILURE_NONE;
    out->output_length = (uint32_t)used;
  }
  if (out->status != DBL_STATUS_OK) {
    out->output_length = 0;
    erase(bytes, sizeof(bytes));
  }
  if (!disconnected) {
    full_write(client, out, sizeof(*out));
    if (out->status == DBL_STATUS_OK)
      full_write(client, bytes, used);
  }
  erase(bytes, sizeof(bytes));
}

static void serve(int client) {
  struct ucred peer;
  socklen_t pl = sizeof(peer);
  struct dbl_request q = {0};
  struct dbl_registration r;
  struct dbl_result out;
  memset(&out, 0, sizeof(out));
  out.version = DBL_VERSION;
  out.status = DBL_STATUS_PRELAUNCH_FAILED;
  out.exit_code = -1;
  out.stage = DBL_STAGE_PEER;
  out.failure_class = DBL_FAILURE_PEER;
  int fds[2] = {-1, -1}, pipes[2] = {-1, -1}, exe = -1;
  uint32_t launch_failure = 0;
  uint64_t launch_start_ticks = 0;
  pid_t pid;
  if (getsockopt(client, SOL_SOCKET, SO_PEERCRED, &peer, &pl) ||
      peer.uid != DBL_BROKER_UID)
    goto done;
  out.stage = DBL_STAGE_REQUEST;
  out.failure_class = DBL_FAILURE_PROTOCOL;
  if (receive_request(client, &q, fds) || q.version != DBL_VERSION ||
      !safe_component(q.request_id, sizeof(q.request_id)) ||
      !safe_component(q.turn_id, sizeof(q.turn_id)) ||
      !safe_component(q.agent_id, sizeof(q.agent_id)) ||
      !safe_component(q.wake_id, sizeof(q.wake_id)) ||
      !sealed_regular(fds[0], DBL_MAX_PROMPT) ||
      !sealed_regular(fds[1], DBL_MAX_CAPABILITY_BUNDLE))
    goto done;
  memcpy(out.turn_id, q.turn_id, sizeof(out.turn_id));
  out.stage = DBL_STAGE_REGISTRATION;
  out.failure_class = DBL_FAILURE_REGISTRATION;
  if (load_registration(q.slot, &r) || !valid_registration(&r, &q))
    goto done;
  out.stage = DBL_STAGE_EXECUTABLE;
  out.failure_class = DBL_FAILURE_EXECUTABLE;
  if ((exe = executable_fd(&r)) < 0)
    goto done;
  out.stage = DBL_STAGE_EXEC;
  out.failure_class = DBL_FAILURE_EXEC;
  if (pipe2(pipes, O_CLOEXEC | O_NONBLOCK))
    goto done;
  pid = launch(&r, exe, fds[0], fds[1], pipes[1], &launch_failure,
               &launch_start_ticks);
  if (pid < 1)
    goto done;
  close(pipes[1]);
  pipes[1] = -1;
  out.status = DBL_STATUS_OK;
  out.worker_pid = pid;
  out.worker_uid = r.uid;
  out.start_ticks = launch_start_ticks;
  supervise(client, pid, pipes[0], &out);
  goto cleanup;
done:
  (void)launch_failure;
  full_write(client, &out, sizeof(out));
cleanup:
  for (size_t i = 0; i < 2; i++) {
    if (fds[i] >= 0)
      close(fds[i]);
    if (pipes[i] >= 0)
      close(pipes[i]);
  }
  if (exe >= 0)
    close(exe);
}

static int client_memfd(const char *name, const unsigned char *bytes,
                        uint32_t length) {
  int fd =
      (int)syscall(SYS_memfd_create, name, MFD_ALLOW_SEALING | MFD_CLOEXEC);
  if (fd < 0 || full_write(fd, bytes, length) || lseek(fd, 0, SEEK_SET) < 0 ||
      fcntl(fd, F_ADD_SEALS,
            F_SEAL_WRITE | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL)) {
    if (fd >= 0)
      close(fd);
    return -1;
  }
  return fd;
}
static int client_send(int socket_fd, const struct dbl_request *r, int prompt,
                       int capability) {
  char control[CMSG_SPACE(sizeof(int) * 2)] = {0};
  int fds[2] = {prompt, capability};
  struct iovec io = {(void *)r, sizeof(*r)};
  struct msghdr m = {.msg_iov = &io,
                     .msg_iovlen = 1,
                     .msg_control = control,
                     .msg_controllen = sizeof(control)};
  struct cmsghdr *c = CMSG_FIRSTHDR(&m);
  c->cmsg_level = SOL_SOCKET;
  c->cmsg_type = SCM_RIGHTS;
  c->cmsg_len = CMSG_LEN(sizeof(fds));
  memcpy(CMSG_DATA(c), fds, sizeof(fds));
  return sendmsg(socket_fd, &m, MSG_NOSIGNAL) == (ssize_t)sizeof(*r) ? 0 : -1;
}
static int closed_result(const struct dbl_result *r, const char turn_id[65]) {
  if (r->version != DBL_VERSION || r->reserved || r->profile_applied > 1 ||
      r->stage > DBL_STAGE_ATTESTATION ||
      r->failure_class > DBL_FAILURE_ATTESTATION_PROFILE_INVALID ||
      r->output_length > DBL_MAX_OUTPUT || memcmp(r->turn_id, turn_id, 65))
    return 0;
  if (r->status == DBL_STATUS_OK)
    return r->stage == DBL_STAGE_OUTPUT &&
           r->failure_class == DBL_FAILURE_NONE && r->profile_applied == 0 &&
           r->worker_pid > 0 && r->worker_uid >= 2200 && r->start_ticks &&
           r->exit_code == 0 && r->term_signal == 0;
  if (r->status == DBL_STATUS_PRELAUNCH_FAILED)
    return r->stage >= DBL_STAGE_PEER && r->stage <= DBL_STAGE_EXEC &&
           r->failure_class >= DBL_FAILURE_PEER &&
           r->failure_class <= DBL_FAILURE_EXEC && r->worker_pid == 0 &&
           r->worker_uid == 0 && r->start_ticks == 0 && r->output_length == 0;
  if (r->status == DBL_STATUS_WORKER_FAILED)
    return r->stage == DBL_STAGE_WAIT &&
           (r->failure_class == DBL_FAILURE_EXEC ||
            r->failure_class == DBL_FAILURE_WAIT) &&
           r->worker_pid > 0 && r->worker_uid >= 2200 && r->start_ticks &&
           r->output_length == 0;
  if (r->status == DBL_STATUS_OUTPUT_FAILED)
    return r->stage == DBL_STAGE_OUTPUT &&
           r->failure_class == DBL_FAILURE_OUTPUT_LIMIT && r->worker_pid > 0 &&
           r->worker_uid >= 2200 && r->start_ticks && r->output_length == 0;
  if (r->status == DBL_STATUS_CANCELLED)
    return r->stage == DBL_STAGE_WAIT &&
           r->failure_class == DBL_FAILURE_CANCELLED && r->worker_pid > 0 &&
           r->worker_uid >= 2200 && r->start_ticks && r->output_length == 0;
  return 0;
}

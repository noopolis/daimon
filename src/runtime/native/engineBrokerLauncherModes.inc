static int client_mode(void) {
  struct dbl_request request;
  uint32_t prompt_length = 0, capability_length = 0;
  unsigned char *prompt = NULL, capability[DBL_MAX_CAPABILITY_BUNDLE] = {0},
                output[DBL_MAX_OUTPUT] = {0}, extra;
  struct dbl_result result;
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  int s = -1, p = -1, c = -1, ok = -1;
  if (getuid() != DBL_BROKER_UID)
    goto done;
  if (full_read(STDIN_FILENO, &request, sizeof(request)) ||
      full_read(STDIN_FILENO, &prompt_length, sizeof(prompt_length)) ||
      !prompt_length || prompt_length > DBL_MAX_PROMPT ||
      (prompt = malloc(prompt_length)) == NULL ||
      full_read(STDIN_FILENO, prompt, prompt_length) ||
      full_read(STDIN_FILENO, &capability_length, sizeof(capability_length)) ||
      !capability_length || capability_length > DBL_MAX_CAPABILITY_BUNDLE ||
      full_read(STDIN_FILENO, capability, capability_length) ||
      read(STDIN_FILENO, &extra, 1) != 0)
    goto done;
  if (request.version != DBL_VERSION ||
      !safe_component(request.request_id, sizeof(request.request_id)) ||
      !safe_component(request.turn_id, sizeof(request.turn_id)) ||
      !safe_component(request.agent_id, sizeof(request.agent_id)) ||
      !safe_component(request.wake_id, sizeof(request.wake_id)))
    goto done;
  p = client_memfd("daimon-prompt", prompt, prompt_length);
  c = client_memfd("daimon-capability", capability, capability_length);
  erase(prompt, prompt_length);
  erase(capability, sizeof(capability));
  if (p < 0 || c < 0 ||
      (s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0)) < 0)
    goto done;
  memcpy(a.sun_path, DBL_SOCKET, sizeof(DBL_SOCKET));
  if (connect(s, (struct sockaddr *)&a,
              offsetof(struct sockaddr_un, sun_path) + strlen(a.sun_path) +
                  1) ||
      client_send(s, &request, p, c) || full_read(s, &result, sizeof(result)) ||
      !closed_result(&result, request.turn_id) ||
      full_read(s, output, result.output_length) || read(s, &extra, 1) != 0) {
    struct dbl_result failure;
    memset(&failure, 0, sizeof(failure));
    failure.version = DBL_VERSION;
    failure.status = DBL_STATUS_PRELAUNCH_FAILED;
    failure.exit_code = -1;
    failure.stage = DBL_STAGE_REQUEST;
    failure.failure_class = DBL_FAILURE_PROTOCOL;
    memcpy(failure.turn_id, request.turn_id, sizeof(failure.turn_id));
    if (full_write(STDOUT_FILENO, &failure, sizeof(failure)) == 0)
      ok = 0;
    goto done;
  }
  if (full_write(STDOUT_FILENO, &result, sizeof(result)) ||
      full_write(STDOUT_FILENO, output, result.output_length))
    goto done;
  ok = 0;
done:
  if (prompt) {
    erase(prompt, prompt_length);
    free(prompt);
  }
  erase(capability, sizeof(capability));
  erase(output, sizeof(output));
  erase(&request, sizeof(request));
  prompt_length = 0;
  capability_length = 0;
  if (s >= 0)
    close(s);
  if (p >= 0)
    close(p);
  if (c >= 0)
    close(c);
  return ok;
}
static int auth_provider_mode(void) {
  unsigned char provider[DBL_MAX_TOKEN + 1] = {0};
  int ok = -1;
  if (getuid() < 2200 || capability_bundle(4, provider, NULL))
    goto done;
  const char prefix[] = "{\"access_token\":\"",
             suffix[] = "\",\"expires_in\":600}\n";
  size_t n = strlen((char *)provider);
  if (full_write(STDOUT_FILENO, prefix, sizeof(prefix) - 1) ||
      full_write(STDOUT_FILENO, provider, n) ||
      full_write(STDOUT_FILENO, suffix, sizeof(suffix) - 1))
    goto done;
  ok = 0;
done:
  erase(provider, sizeof(provider));
  return ok;
}

static int relay_frame(int from, int to) {
  unsigned char header[4], buffer[8192];
  if (full_read(from, header, sizeof(header)))
    return 0;
  uint32_t length = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
                    ((uint32_t)header[2] << 8) | header[3];
  if (!length || length > DBL_MAX_CONTROL_FRAME)
    return -1;
  if (full_write(to, header, sizeof(header)))
    return -1;
  while (length) {
    size_t chunk = length < sizeof(buffer) ? length : sizeof(buffer);
    if (full_read(from, buffer, chunk) || full_write(to, buffer, chunk))
      return -1;
    length -= (uint32_t)chunk;
  }
  erase(buffer, sizeof(buffer));
  return 1;
}
static int backend_connect(void) {
  struct stat s;
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  struct ucred peer;
  socklen_t size = sizeof(peer);
  if (lstat(DBL_BACKEND_SOCKET, &s) || !S_ISSOCK(s.st_mode) ||
      s.st_uid != DBL_BROKER_UID || (s.st_mode & 077) != 0)
    return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0)
    return -1;
  memcpy(a.sun_path, DBL_BACKEND_SOCKET, sizeof(DBL_BACKEND_SOCKET));
  if (connect(fd, (struct sockaddr *)&a,
              offsetof(struct sockaddr_un, sun_path) + strlen(a.sun_path) +
                  1) ||
      getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) ||
      peer.uid != DBL_BROKER_UID) {
    close(fd);
    return -1;
  }
  return fd;
}
static void relay_connection(int org) {
  struct ucred peer;
  socklen_t size = sizeof(peer);
  if (getsockopt(org, SOL_SOCKET, SO_PEERCRED, &peer, &size) ||
      peer.uid != DBL_ORG_UID)
    return;
  int backend = backend_connect();
  if (backend < 0)
    return;
  struct timeval deadline = {.tv_sec = 10, .tv_usec = 0};
  if (setsockopt(org, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline)) ||
      setsockopt(org, SOL_SOCKET, SO_SNDTIMEO, &deadline, sizeof(deadline)) ||
      setsockopt(backend, SOL_SOCKET, SO_RCVTIMEO, &deadline,
                 sizeof(deadline)) ||
      setsockopt(backend, SOL_SOCKET, SO_SNDTIMEO, &deadline,
                 sizeof(deadline))) {
    close(backend);
    return;
  }
  struct pollfd descriptors[2] = {{org, POLLIN | POLLHUP | POLLERR, 0},
                                  {backend, POLLIN | POLLHUP | POLLERR, 0}};
  int open[2] = {1, 1};
  while (open[0] || open[1]) {
    int ready = poll(descriptors, 2, -1);
    if (ready < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    for (int i = 0; i < 2; i++) {
      if (!open[i])
        continue;
      int other = 1 - i, from = i ? backend : org, to = i ? org : backend;
      if (descriptors[i].revents & POLLIN) {
        int result = relay_frame(from, to);
        if (result < 1) {
          open[i] = 0;
          shutdown(to, SHUT_WR);
          if (result < 0) {
            open[other] = 0;
            shutdown(from, SHUT_RDWR);
            shutdown(to, SHUT_RDWR);
          }
        }
      }
      if (descriptors[i].revents & (POLLHUP | POLLERR)) {
        open[i] = 0;
        shutdown(to, SHUT_WR);
      }
    }
  }
  close(backend);
}
static int relay_mode(void) {
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  struct rlimit z = {0, 0};
  if (geteuid() != 0)
    return -1;
  int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0)
    return -1;
  unlink(DBL_CONTROL_SOCKET);
  memcpy(a.sun_path, DBL_CONTROL_SOCKET, sizeof(DBL_CONTROL_SOCKET));
  mode_t old = umask(0007);
  if (bind(listener, (struct sockaddr *)&a,
           offsetof(struct sockaddr_un, sun_path) + strlen(a.sun_path) + 1) ||
      chown(DBL_CONTROL_SOCKET, 0, DBL_ORG_UID) ||
      chmod(DBL_CONTROL_SOCKET, 0660) || listen(listener, 32)) {
    umask(old);
    close(listener);
    return -1;
  }
  umask(old);
  if (setrlimit(RLIMIT_CORE, &z))
    die();
  drop_bounding_caps();
  if (setgroups(0, NULL) || prctl(PR_SET_KEEPCAPS, 1, 0, 0, 0) ||
      setresgid(DBL_BROKER_UID, DBL_BROKER_UID, DBL_BROKER_UID) ||
      setresuid(DBL_BROKER_UID, DBL_BROKER_UID, DBL_BROKER_UID))
    die();
  zero_caps();
  if (prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))
    die();
  for (int cap = 0; cap < 256; cap++) {
    int present = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (present < 0) {
      if (errno == EINVAL)
        break;
      die();
    }
    if (present)
      die();
  }
  for (;;) {
    int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    if (client < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    pid_t child = fork();
    if (child == 0) {
      if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() == 1)
        die();
      close(listener);
      relay_connection(client);
      close(client);
      _exit(0);
    }
    close(client);
    while (waitpid(-1, NULL, WNOHANG) > 0) {
    }
  }
  close(listener);
  return -1;
}

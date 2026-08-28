static int unix_listener(const char *path, mode_t mode) {
  unlink(path);
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  strcpy(a.sun_path, path);
  check(s >= 0 && !bind(s, (void *)&a, sizeof(a)) && !chmod(path, mode) &&
            !listen(s, 4),
        "unix listener");
  return s;
}
static pid_t backend_once(unsigned delay_seconds) {
  pid_t child = fork();
  if (!child) {
    setgid(DBL_BROKER_UID);
    setuid(DBL_BROKER_UID);
    int s = unix_listener(DBL_BACKEND_SOCKET, 0600),
        peer = accept(s, NULL, NULL);
    unsigned char header[4], body[256];
    if (!read_all(peer, header, 4))
      _exit(31);
    uint32_t n = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
                 ((uint32_t)header[2] << 8) | header[3];
    if (n > sizeof(body) || !read_all(peer, body, n))
      _exit(32);
    if (delay_seconds)
      sleep(delay_seconds);
    write(peer, header, 4);
    write(peer, body, n);
    shutdown(peer, SHUT_WR);
    close(peer);
    close(s);
    _exit(0);
  }
  for (int i = 0; i < 50 && access(DBL_BACKEND_SOCKET, F_OK); i++)
    usleep(20000);
  return child;
}
static pid_t backend_eof(void) {
  pid_t child = fork();
  if (!child) {
    setgid(DBL_BROKER_UID);
    setuid(DBL_BROKER_UID);
    int s = unix_listener(DBL_BACKEND_SOCKET, 0600),
        peer = accept(s, NULL, NULL);
    char byte;
    for (int attempt = 0; attempt < 3; attempt++) {
      ssize_t observed = read(peer, &byte, 1);
      if (observed == 0)
        _exit(0);
      if (observed > 0 || (errno != EAGAIN && errno != EWOULDBLOCK))
        _exit(51);
    }
    _exit(51);
  }
  for (int i = 0; i < 50 && access(DBL_BACKEND_SOCKET, F_OK); i++)
    usleep(20000);
  return child;
}
static pid_t backend_wait(pid_t relay) {
  pid_t child = fork();
  if (!child) {
    setgid(DBL_BROKER_UID);
    setuid(DBL_BROKER_UID);
    int s = unix_listener(DBL_BACKEND_SOCKET, 0600),
        peer = accept(s, NULL, NULL);
    unsigned char frame[6];
    if (!read_all(peer, frame, sizeof(frame)))
      _exit(61);
    if (kill(relay, SIGKILL))
      _exit(62);
    char byte;
    _exit(read(peer, &byte, 1) <= 0 ? 0 : 63);
  }
  for (int i = 0; i < 50 && access(DBL_BACKEND_SOCKET, F_OK); i++)
    usleep(20000);
  return child;
}
static void org_relay_reject(const unsigned char *frame, size_t length) {
  pid_t child = fork();
  if (!child) {
    setgid(DBL_ORG_UID);
    setuid(DBL_ORG_UID);
    int s = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    strcpy(a.sun_path, DBL_CONTROL_SOCKET);
    if (connect(s, (void *)&a, sizeof(a)) || !write_all(s, frame, length))
      _exit(52);
    char byte;
    _exit(read(s, &byte, 1) <= 0 ? 0 : 53);
  }
  int status;
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "relay rejection");
}
static void relay_identity(pid_t relay) {
  char file[64], line[256];
  snprintf(file, sizeof(file), "/proc/%ld/status", (long)relay);
  for (int attempt = 0; attempt < 50; attempt++) {
    FILE *status = fopen(file, "r");
    uid_t uid = (uid_t)-1;
    unsigned long long effective = 1, permitted = 1, ambient = 1, bounding = 1;
    unsigned no_new_privs = 0;
    if (status) {
      while (fgets(line, sizeof(line), status)) {
        if (sscanf(line, "Uid:\t%u", &uid) == 1)
          continue;
        if (sscanf(line, "CapEff:\t%llx", &effective) == 1)
          continue;
        if (sscanf(line, "CapPrm:\t%llx", &permitted) == 1)
          continue;
        if (sscanf(line, "CapAmb:\t%llx", &ambient) == 1)
          continue;
        if (sscanf(line, "CapBnd:\t%llx", &bounding) == 1)
          continue;
        sscanf(line, "NoNewPrivs:\t%u", &no_new_privs);
      }
      fclose(status);
    }
    if (uid == DBL_BROKER_UID && effective == 0 && permitted == 0 &&
        ambient == 0 && bounding == 0 && no_new_privs == 1) {
      snprintf(file, sizeof(file), "/proc/%ld/limits", (long)relay);
      FILE *limits = fopen(file, "r");
      int core_zero = 0;
      if (limits) {
        while (fgets(line, sizeof(line), limits))
          if (!strncmp(line, "Max core file size", 18) &&
              strstr(line, "0                    0"))
            core_zero = 1;
        fclose(limits);
      }
      if (core_zero)
        return;
    }
    usleep(20000);
  }
  check(0, "relay identity/caps");
}
static void relay_requires_setpcap(void) {
  unlink(DBL_CONTROL_SOCKET);
  pid_t child = fork();
  if (!child)
    execlp("setpriv", "setpriv", "--inh-caps=-all", "--ambient-caps=-all",
           "--bounding-set=-all,+chown,+setuid,+setgid", "--",
           "/opt/daimon/bin/daimon-engine-broker", "--relay", NULL);
  int status;
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 111,
        "relay requires setpcap");
  unlink(DBL_CONTROL_SOCKET);
}
static void relay_cases(void) {
  puts("native-stage relay start");
  chmod("/run/daimon-engine-broker", 0777);
  relay_requires_setpcap();
  puts("native-stage relay caps complete");
  pid_t backend = backend_once(11), relay = fork();
  check(relay >= 0, "relay fork");
  if (!relay)
    execlp("setpriv", "setpriv", "--inh-caps=-all", "--ambient-caps=-all",
           "--bounding-set=-all,+chown,+setuid,+setgid,+setpcap", "--",
           "/opt/daimon/bin/daimon-engine-broker", "--relay", NULL);
  for (int i = 0; i < 50 && access(DBL_CONTROL_SOCKET, F_OK); i++)
    usleep(20000);
  struct stat control;
  check(!lstat(DBL_CONTROL_SOCKET, &control) && S_ISSOCK(control.st_mode) &&
            control.st_uid == 0 && control.st_gid == DBL_ORG_UID &&
            (control.st_mode & 0777) == 0660,
        "control socket authority");
  relay_identity(relay);
  puts("native-stage relay identity complete");
  int spoof = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  strcpy(a.sun_path, DBL_CONTROL_SOCKET);
  check(!connect(spoof, (void *)&a, sizeof(a)), "spoof connect");
  unsigned char frame[] = {0, 0, 0, 2, '{', '}'};
  write(spoof, frame, sizeof(frame));
  check(read(spoof, frame, 1) <= 0, "org uid spoof rejection");
  close(spoof);
  pid_t org = fork();
  if (!org) {
    setgid(DBL_ORG_UID);
    setuid(DBL_ORG_UID);
    int s = socket(AF_UNIX, SOCK_STREAM, 0);
    connect(s, (void *)&a, sizeof(a));
    unsigned char request_frame[] = {0, 0, 0, 2, '{', '}'};
    write(s, request_frame, sizeof(request_frame));
    shutdown(s, SHUT_WR);
    unsigned char response[6];
    if (!read_all(s, response, sizeof(response)) ||
        memcmp(request_frame, response, sizeof(response)))
      _exit(41);
    if (read(s, response, 1) != 0)
      _exit(42);
    _exit(0);
  }
  int status;
  waitpid(org, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        "relay exact frame/half close");
  waitpid(backend, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "backend relay");
  puts("native-stage relay idle success complete");
  unlink(DBL_BACKEND_SOCKET);
  backend = backend_eof();
  unsigned char partial[] = {0, 0, 0, 2, '{'};
  org_relay_reject(partial, sizeof(partial));
  kill(backend, SIGKILL);
  waitpid(backend, &status, 0);
  puts("native-stage relay partial deadline complete");
  unlink(DBL_BACKEND_SOCKET);
  backend = backend_eof();
  unsigned char oversized[] = {0, 16, 0, 1};
  org_relay_reject(oversized, sizeof(oversized));
  waitpid(backend, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "oversized relay frame");
  puts("native-stage relay oversized complete");
  unlink(DBL_BACKEND_SOCKET);
  int wrong = unix_listener(DBL_BACKEND_SOCKET, 0600);
  org_relay_reject(frame, sizeof(frame));
  puts("native-stage relay wrong-backend complete");
  close(wrong);
  unlink(DBL_BACKEND_SOCKET);
  backend = backend_wait(relay);
  org = fork();
  if (!org) {
    setgid(DBL_ORG_UID);
    setuid(DBL_ORG_UID);
    int s = socket(AF_UNIX, SOCK_STREAM, 0);
    connect(s, (void *)&a, sizeof(a));
    write_all(s, frame, sizeof(frame));
    char byte;
    _exit(read(s, &byte, 1) <= 0 ? 0 : 63);
  }
  puts("native-stage relay death kill");
  check(wait_bounded(relay, &status), "relay bounded reap");
  puts("native-stage relay parent dead");
  check(wait_bounded(org, &status) && WIFEXITED(status) &&
            WEXITSTATUS(status) == 0,
        "relay death propagates");
  puts("native-stage relay org dead");
  check(wait_bounded(backend, &status) && WIFEXITED(status) &&
            WEXITSTATUS(status) == 0,
        "relay death closes backend");
  unlink(DBL_CONTROL_SOCKET);
  unlink(DBL_BACKEND_SOCKET);
}

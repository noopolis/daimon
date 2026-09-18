/* Non-canonical or unterminated homes/workspaces are refused at registration:
   HOME, GROK_HOME and TMPDIR are derived from them. */
static void noncanonical_registration_cases(struct dbl_registration r) {
  const char *homes[] = {"/tmp/worker-home/../other", "/tmp//worker-home",
                         "/tmp/worker-home/", "/tmp/./worker-home",
                         "/tmp/worker-home/..", "relative/home", NULL};
  struct dbl_registration bad[8];
  size_t count = 0;
  for (; homes[count]; count++) {
    bad[count] = r;
    bad[count].slot = 100 + (uint32_t)count;
    memset(bad[count].home, 0, sizeof(bad[count].home));
    strcpy(bad[count].home, homes[count]);
  }
  bad[count] = r;
  bad[count].slot = 100 + (uint32_t)count;
  memset(bad[count].home, 'a', sizeof(bad[count].home)); /* over-long: no NUL */
  bad[count].home[0] = '/';
  count++;
  bad[count] = r;
  bad[count].slot = 100 + (uint32_t)count;
  strcpy(bad[count].workspace, "/tmp/workspace/../etc");
  count++;
  int f = open(DBL_REGISTRY, O_TRUNC | O_WRONLY, 0600);
  check(f >= 0 && write(f, &r, sizeof(r)) == sizeof(r) &&
            write(f, bad, sizeof(bad[0]) * count) ==
                (ssize_t)(sizeof(bad[0]) * count),
        "noncanonical registry");
  close(f);
  pid_t child = fork();
  if (!child) {
    setgid(DBL_BROKER_UID);
    setuid(DBL_BROKER_UID);
    for (size_t i = 0; i < count; i++) {
      int s = connect_socket(), p = sealed("prompt"),
          c = sealed_bundle("provider.Path-1", "mcp.Path-2");
      struct dbl_request q = request();
      struct dbl_result result;
      q.slot = 100 + (uint32_t)i;
      send_request(s, &q, p, c);
      if (!read_all(s, &result, sizeof(result)) ||
          result.status != DBL_STATUS_PRELAUNCH_FAILED ||
          result.stage != DBL_STAGE_REGISTRATION || result.worker_pid != 0)
        _exit(10 + (int)i);
      close(s);
      close(p);
      close(c);
    }
    _exit(0);
  }
  int status;
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        "noncanonical registration refused");
  f = open(DBL_REGISTRY, O_TRUNC | O_WRONLY, 0600);
  check(f >= 0 && write(f, &r, sizeof(r)) == sizeof(r), "registry restore");
  close(f);
}
/* A worker that fails before or at exec must not run anything: the launcher
   child exits instead. The registered "executable" is a #! script; fd 5 is
   close-on-exec, so execveat(AT_EMPTY_PATH) cannot run it (a script needs
   /dev/fd/5 after exec) and the turn fails at the exec stage. */
static void exec_failure_case(struct dbl_registration r) {
  const char *marker = "/tmp/exec-failure-script-ran";
  unlink(marker);
  check(rename("/usr/local/bin/grok", "/usr/local/bin/grok.fixture") == 0,
        "exec failure fixture move");
  int script = open("/usr/local/bin/grok", O_CREAT | O_EXCL | O_WRONLY, 0755);
  const char body[] = "#!/bin/sh\ntouch /tmp/exec-failure-script-ran\n";
  check(script >= 0 && write(script, body, sizeof(body) - 1) ==
                           (ssize_t)(sizeof(body) - 1),
        "exec failure script");
  close(script);
  digest("/usr/local/bin/grok", r.executable_sha256);
  int f = open(DBL_REGISTRY, O_TRUNC | O_WRONLY, 0600);
  check(f >= 0 && write(f, &r, sizeof(r)) == sizeof(r), "exec failure registry");
  close(f);
  pid_t child = fork();
  if (!child) {
    setgid(DBL_BROKER_UID);
    setuid(DBL_BROKER_UID);
    int s = connect_socket(), p = sealed("prompt"),
        c = sealed_bundle("provider.Exec-1", "mcp.Exec-2");
    struct dbl_request q = request();
    struct dbl_result result;
    send_request(s, &q, p, c);
    _exit(read_all(s, &result, sizeof(result)) &&
                  result.status == DBL_STATUS_PRELAUNCH_FAILED &&
                  result.stage == DBL_STAGE_EXEC &&
                  result.failure_class == DBL_FAILURE_EXEC &&
                  result.worker_pid == 0
              ? 0
              : 1);
  }
  int status;
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "exec failure result");
  sleep(1);
  check(access(marker, F_OK) != 0, "exec failure ran nothing");
  unlink("/usr/local/bin/grok");
  check(rename("/usr/local/bin/grok.fixture", "/usr/local/bin/grok") == 0,
        "exec failure fixture restore");
  digest("/usr/local/bin/grok", r.executable_sha256);
  f = open(DBL_REGISTRY, O_TRUNC | O_WRONLY, 0600);
  check(f >= 0 && write(f, &r, sizeof(r)) == sizeof(r), "registry restore");
  close(f);
}
int main(void) {
  setbuf(stdout, NULL);
  alarm(40);
  check(sizeof(struct dbl_result) == DBL_RESULT_SIZE &&
            offsetof(struct dbl_result, stage) == DBL_RESULT_STAGE_OFFSET &&
            offsetof(struct dbl_result, failure_class) ==
                DBL_RESULT_FAILURE_CLASS_OFFSET &&
            offsetof(struct dbl_result, profile_applied) ==
                DBL_RESULT_PROFILE_APPLIED_OFFSET &&
            offsetof(struct dbl_result, diagnostic_length) ==
                DBL_RESULT_DIAGNOSTIC_LENGTH_OFFSET,
        "result ABI");
  mkdir("/run/daimon-engine-broker", 0755);
  mkdir("/etc/daimon-engine-broker", 0755);
  mkdir("/tmp/worker-home", 0777);
  mkdir("/tmp/workspace", 0777);
  struct dbl_registration old = {
      .version = 1, .slot = 8, .uid = 2200, .gid = 2200};
  strcpy(old.agent_id, "agent-1");
  strcpy(old.workspace, "/tmp/workspace");
  strcpy(old.home, "/tmp/worker-home");
  digest("/usr/local/bin/grok", old.executable_sha256);
  struct dbl_registration r = {
      .version = DBL_VERSION, .slot = 7, .uid = 2200, .gid = 2200};
  strcpy(r.agent_id, "agent-1");
  strcpy(r.workspace, "/tmp/workspace");
  strcpy(r.home, "/tmp/worker-home");
  digest("/usr/local/bin/grok", r.executable_sha256);
  int f = open(DBL_REGISTRY, O_CREAT | O_TRUNC | O_WRONLY, 0600);
  check(f >= 0 && write(f, &old, sizeof(old)) == sizeof(old), "v1 registry");
  close(f);
  pid_t old_broker = fork();
  if (!old_broker)
    execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker", NULL);
  check(old_broker > 0, "v1 broker fork");
  wait_launcher_ready(old_broker);
  abi_v1_registration_rejects();
  kill(old_broker, SIGKILL);
  waitpid(old_broker, NULL, 0);
  unlink(DBL_SOCKET);
  f = open(DBL_REGISTRY, O_TRUNC | O_WRONLY, 0600);
  check(f >= 0 && write(f, &r, sizeof(r)) == sizeof(r), "v2 registry");
  close(f);
  auth_adversarial_cases();
  puts("native-stage auth complete");
  pid_t broker = fork();
  if (!broker) {
    /* A real launcher stdin, so a worker inheriting it is visible. */
    int launcher_stdin = open("/etc/hostname", O_RDONLY);
    if (launcher_stdin < 0 || dup2(launcher_stdin, STDIN_FILENO) < 0)
      _exit(1);
    execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker", NULL);
  }
  check(broker > 0, "broker fork");
  wait_launcher_ready(broker);
  root_peer_rejects();
  org_launcher_rejects();
  pid_t org = fork();
  if (!org) {
    org_cases();
    _exit(0);
  }
  int status;
  waitpid(org, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "org cases");
  exec_failure_case(r);
  puts("native-stage exec failure complete");
  noncanonical_registration_cases(r);
  puts("native-stage noncanonical registration complete");
  kill(broker, SIGKILL);
  waitpid(broker, 0, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "org cases");
  puts("native-stage launcher complete");
  malformed_response_case(1);
  malformed_response_case(0);
  puts("native-stage client protocol complete");
  relay_cases();
  puts("native broker adversarial integration passed");
}

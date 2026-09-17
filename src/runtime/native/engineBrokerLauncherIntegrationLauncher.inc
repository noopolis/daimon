static void root_peer_rejects(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("provider.Token-1", "mcp.Token-2");
  struct dbl_request q = request();
  struct dbl_result r;
  send_one(s, &q, p);
  check(read(s, &r, sizeof(r)) == sizeof(r) && r.status == 1,
        "fd count rejection");
  close(s);
  s = connect_socket();
  send_request(s, &q, p, c);
  check(read(s, &r, sizeof(r)) == sizeof(r) && r.status == 1,
        "root peer rejection");
  close(s);
  close(p);
  close(c);
}
static void org_launcher_rejects(void) {
  pid_t child = fork();
  if (!child) {
    setgid(DBL_ORG_UID);
    setuid(DBL_ORG_UID);
    int s = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    strcpy(a.sun_path, DBL_SOCKET);
    _exit(connect(s, (void *)&a, sizeof(a)) < 0 ? 0 : 1);
  }
  int status;
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        "org launcher rejection");
}
static void abi_v1_registration_rejects(void) {
  pid_t child = fork();
  if (!child) {
    setgid(DBL_BROKER_UID);
    setuid(DBL_BROKER_UID);
    int s = connect_socket(), p = sealed("prompt"),
        c = sealed_bundle("provider.Token-1", "mcp.Token-2");
    struct dbl_request q = request();
    q.slot = 8;
    struct dbl_result r;
    send_request(s, &q, p, c);
    _exit(read_all(s, &r, sizeof(r)) &&
                  r.status == DBL_STATUS_PRELAUNCH_FAILED &&
                  r.stage == DBL_STAGE_REGISTRATION &&
                  r.failure_class == DBL_FAILURE_REGISTRATION
              ? 0
              : 1);
  }
  int status;
  waitpid(child, &status, 0);
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        "ABI v1 registration rejection");
}
static void output_boundary_case(const char *provider, int overflow) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle(provider, "mcp.Output-2");
  struct dbl_request q = request();
  struct dbl_result r;
  send_request(s, &q, p, c);
  check(read_all(s, &r, sizeof(r)) && result_padding_zero(&r),
        "output boundary result");
  if (overflow) {
    check(r.status == DBL_STATUS_OUTPUT_FAILED &&
              r.stage == DBL_STAGE_OUTPUT &&
              r.failure_class == DBL_FAILURE_OUTPUT_LIMIT &&
              r.output_length == 0 && r.worker_pid > 0 &&
              r.worker_uid == 2200 && r.start_ticks > 0,
          "output overflow diagnostic");
  } else {
    char *bytes = malloc(DBL_MAX_OUTPUT);
    check(r.status == DBL_STATUS_OK && r.stage == DBL_STAGE_OUTPUT &&
              r.failure_class == DBL_FAILURE_NONE &&
              r.output_length == DBL_MAX_OUTPUT &&
              read_all(s, bytes, DBL_MAX_OUTPUT),
          "exact output boundary");
    free(bytes);
  }
  char extra;
  check(read(s, &extra, 1) == 0, "output boundary EOF");
  close(s);
  close(p);
  close(c);
}
/* A worker that exits nonzero publishes no output, but its own last words —
   stderr and stdout share one pipe — must survive as the bounded diagnostic
   tail, because the host otherwise sees nothing but `exit=1`. */
static void worker_failure_case(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("stderr-failure", "mcp.Failure-2");
  struct dbl_request q = request();
  struct dbl_result r;
  send_request(s, &q, p, c);
  check(read_all(s, &r, sizeof(r)) && result_padding_zero(&r) &&
            r.status == DBL_STATUS_WORKER_FAILED && r.stage == DBL_STAGE_WAIT &&
            r.failure_class == DBL_FAILURE_EXEC && r.exit_code == 1 &&
            r.term_signal == 0 && r.worker_pid > 0 && r.worker_uid == 2200 &&
            r.start_ticks > 0 && r.output_length == 0 &&
            r.diagnostic_length > 0 &&
            r.diagnostic_length <= DBL_MAX_DIAGNOSTIC,
        "worker failure diagnostic length");
  char *reason = calloc(1, r.diagnostic_length + 1);
  check(read_all(s, reason, r.diagnostic_length) &&
            strstr(reason, "grok: session store unwritable"),
        "worker failure reason");
  char extra;
  check(read(s, &extra, 1) == 0, "worker failure EOF");
  free(reason);
  close(s);
  close(p);
  close(c);
}
/* A worker that dies after printing far more than the window: the error is at
   the START of what it printed and the echo at the end, which is the shape a
   pure tail got wrong. The distinctive head run STRADDLES the head's own cut —
   its first bytes are inside the retained head and its later bytes are elided —
   so a tail-only window loses it entirely and this case fails. */
static void worker_flood_case(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("stderr-flood", "mcp.Flood-2");
  struct dbl_request q = request();
  struct dbl_result r;
  size_t printed = strlen("HEAD-OF-ERROR grok: profile refused ") + 4096u +
                   strlen(" TAIL-OF-ECHO");
  unsigned long long elided = 0;
  char *reason, *marker, *shown;
  send_request(s, &q, p, c);
  check(read_all(s, &r, sizeof(r)) && r.status == DBL_STATUS_WORKER_FAILED &&
            r.exit_code == 1 && r.output_length == 0 &&
            r.diagnostic_length > 0 &&
            r.diagnostic_length <= DBL_MAX_DIAGNOSTIC,
        "worker flood diagnostic length");
  reason = calloc(1, r.diagnostic_length + 1);
  check(read_all(s, reason, r.diagnostic_length), "worker flood diagnostic");
  check(!strncmp(reason, "HEAD-OF-ERROR grok: profile refused",
                 strlen("HEAD-OF-ERROR grok: profile refused")),
        "worker flood head");
  shown = strstr(reason, " TAIL-OF-ECHO");
  check(shown && shown[strlen(" TAIL-OF-ECHO")] == 0, "worker flood tail");
  marker = strstr(reason, "[\xe2\x80\xa6 ");
  check(marker && sscanf(marker, "[\xe2\x80\xa6 %llu bytes elided", &elided) == 1,
        "worker flood marker");
  /* The count is exactly what was dropped: everything printed, less the two
     ends that survived (the whole window less the marker itself). */
  size_t marker_length = (size_t)(strchr(marker, ']') - marker) + 1u;
  check((size_t)elided + (size_t)r.diagnostic_length - marker_length == printed,
        "worker flood elided count");
  char extra;
  check(read(s, &extra, 1) == 0, "worker flood EOF");
  free(reason);
  close(s);
  close(p);
  close(c);
}
static void org_cases(void) {
  check(!setgid(DBL_BROKER_UID) && !setuid(DBL_BROKER_UID), "drop broker uid");
  client_case();
  client_input_reject(DBL_MAX_PROMPT + 1, 0);
  client_input_reject(5, 1);
  output_boundary_case("exact-output", 0);
  output_boundary_case("overflow-output", 1);
  worker_failure_case();
  worker_flood_case();
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("provider.Token-1", "mcp.Token-2");
  struct dbl_request q = request();
  struct dbl_result r;
  send_one(s, &q, p);
  check(read(s, &r, sizeof(r)) == sizeof(r) && result_padding_zero(&r) &&
            r.status == DBL_STATUS_PRELAUNCH_FAILED &&
            r.stage == DBL_STAGE_REQUEST &&
            r.failure_class == DBL_FAILURE_PROTOCOL,
        "fd count rejection");
  close(s);
  s = connect_socket();
  send_request(s, &q, p, c);
  check(read(s, &r, sizeof(r)) == sizeof(r) && result_padding_zero(&r) &&
            r.status == DBL_STATUS_OK && r.stage == DBL_STAGE_OUTPUT &&
            r.worker_uid == 2200 && r.output_length < DBL_MAX_OUTPUT,
        "valid result");
  char *out = calloc(1, r.output_length + 1);
  check(read(s, out, r.output_length) == (ssize_t)r.output_length &&
            strstr(out, "uid=2200") && strstr(out, "--always-approve") &&
            strstr(out, " prompt=prompt fds=0,1,2,3,4 stdin=/dev/null tmpdir=/tmp/worker-home/tmp\n") &&
            !strstr(out, "EVIL"),
        "fixed worker boundary");
  check(strstr(out, "=--verbatim\n") && strstr(out, "=--no-plan\n") &&
            strstr(out, "=--no-subagents\n") && strstr(out, "=--no-memory\n") &&
            strstr(out, "=--disable-web-search\n") &&
            strstr(out, "=--tools\n") && strstr(out, "=" DBL_GROK_TOOLS "\n") &&
            strstr(out, "=--max-turns\n") &&
            strstr(out, "=" DBL_GROK_MAX_TURNS "\n") &&
            strstr(out, "=--system-prompt-override\n") &&
            strstr(out, "=" DBL_GROK_SYSTEM_PROMPT "\n") &&
            strstr(out, "=--prompt-file\n") &&
            strstr(out, "=/proc/self/fd/3\n") &&
            !strstr(out, "--reasoning-effort") &&
            strstr(out, " argc=23 "),
        "lean worker argv");
  free(out);
  close(s);
  q = request();
  strcpy(q.agent_id, "../../EVIL");
  s = connect_socket();
  send_request(s, &q, p, c);
  check(read(s, &r, sizeof(r)) == sizeof(r) &&
            r.status == DBL_STATUS_PRELAUNCH_FAILED &&
            r.stage == DBL_STAGE_REQUEST &&
            r.failure_class == DBL_FAILURE_PROTOCOL,
        "path injection");
  close(s);
  q = request();
  q.slot = 2200;
  s = connect_socket();
  send_request(s, &q, p, c);
  check(read(s, &r, sizeof(r)) == sizeof(r) &&
            r.status == DBL_STATUS_PRELAUNCH_FAILED &&
            r.stage == DBL_STAGE_REGISTRATION &&
            r.failure_class == DBL_FAILURE_REGISTRATION,
        "registration failure");
  close(s);
  q = request();
  s = connect_socket();
  int sleepfd = sealed_bundle("sleep", "mcp.Sleep-2");
  send_request(s, &q, p, sleepfd);
  close(s);
  sleep(1);
  char command[128];
  snprintf(command, sizeof(command),
           "! pgrep -u 2200 fixture-worker >/dev/null");
  check(system(command) == 0, "disconnect cleanup");
}

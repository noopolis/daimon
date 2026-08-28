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
static void org_cases(void) {
  check(!setgid(DBL_BROKER_UID) && !setuid(DBL_BROKER_UID), "drop broker uid");
  client_case();
  client_input_reject(DBL_MAX_PROMPT + 1, 0);
  client_input_reject(5, 1);
  output_boundary_case("exact-output", 0);
  output_boundary_case("overflow-output", 1);
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
            !strstr(out, "EVIL"),
        "fixed worker boundary");
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

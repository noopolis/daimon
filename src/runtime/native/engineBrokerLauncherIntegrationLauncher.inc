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
/* A worker's single write larger than the pipe buffer must complete, not kill
   it. The launcher created its stdout/stderr pipe O_NONBLOCK as a whole, and
   O_NONBLOCK is a property of the open file description, so the worker
   inherited a non-blocking stdout: Grok 1.0.34 turns the first EAGAIN from a
   headless stdout write into `stdout write failed: Resource temporarily
   unavailable` and exits 1 before it ever reaches the model. Once its init
   frame outgrew a pipe buffer that was every turn, at $0 apiece.
   The fixture shrinks its own stdout pipe to the kernel minimum, reports the
   capacity it actually got, and writes four times that in ONE write, so the
   case straddles the buffer on any host instead of assuming 64 KiB — and
   stays under DBL_MAX_OUTPUT, so it is the write that is bounded here, never
   the turn's output. */
static void worker_spill_case(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("spill-output", "mcp.Spill-2");
  struct dbl_request q = request();
  struct dbl_result r;
  unsigned capacity = 0, count = 0;
  size_t head, filler = 0;
  char *out, *line, extra;
  send_request(s, &q, p, c);
  check(read_all(s, &r, sizeof(r)) && result_padding_zero(&r) &&
            r.status == DBL_STATUS_OK && r.stage == DBL_STAGE_OUTPUT &&
            r.failure_class == DBL_FAILURE_NONE && r.exit_code == 0 &&
            r.term_signal == 0 && r.diagnostic_length == 0 &&
            r.worker_pid > 0 && r.worker_uid == 2200 &&
            r.output_length > 0 && r.output_length <= DBL_MAX_OUTPUT,
        "worker spill survived its own oversized write");
  out = calloc(1, (size_t)r.output_length + 1u);
  check(out && read_all(s, out, r.output_length), "worker spill output");
  line = strchr(out, '\n');
  check(line && sscanf(out, "SPILL cap=%u count=%u", &capacity, &count) == 2 &&
            capacity > 0 && count == r.output_length &&
            count >= capacity * 4u,
        "worker spill straddles the pipe buffer");
  head = (size_t)(line - out) + 1u;
  while (head + filler + 10u < (size_t)r.output_length &&
         out[head + filler] == 's')
    filler++;
  check(head + filler + 10u == (size_t)r.output_length &&
            !memcmp(out + r.output_length - 10, "SPILL-TAIL", 10),
        "worker spill bytes arrived intact");
  check(read(s, &extra, 1) == 0, "worker spill EOF");
  free(out);
  close(s);
  close(p);
  close(c);
}
/* An ordinary working turn must not be able to hit the bound, and its output
   must arrive whole. The fixture writes the shape one live turn measured — a
   9,728-byte init frame and nine 23,320-byte tool-result frames, 219,608
   bytes in all — in frame-sized writes. That is more than three times the
   64 KiB this bound used to be, so at the old value this same turn was
   published as `output_limit` with its whole text discarded; it is the case
   that straddles the raise, and restoring 65536 turns it red. */
static void worker_turn_case(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("turn-output", "mcp.Turn-2");
  struct dbl_request q = request();
  struct dbl_result r;
  const uint32_t expected = 9728u + 23320u * 9u;
  char *out, extra;
  size_t index;
  send_request(s, &q, p, c);
  check(read_all(s, &r, sizeof(r)) && result_padding_zero(&r) &&
            r.status == DBL_STATUS_OK && r.stage == DBL_STAGE_OUTPUT &&
            r.failure_class == DBL_FAILURE_NONE && r.exit_code == 0 &&
            r.term_signal == 0 && r.diagnostic_length == 0 &&
            expected > 65536u &&
            r.output_length == expected,
        "ordinary turn published whole");
  out = calloc(1, (size_t)expected + 1u);
  check(out && read_all(s, out, expected), "ordinary turn output");
  check(!memcmp(out, "TURN-HEAD", 9) &&
            !memcmp(out + expected - 9, "TURN-TAIL", 9),
        "ordinary turn ends intact");
  for (index = 9; index < (size_t)expected - 9u; index++)
    if (out[index] != 'u')
      break;
  check(index == (size_t)expected - 9u, "ordinary turn bytes intact");
  check(read(s, &extra, 1) == 0, "ordinary turn EOF");
  free(out);
  close(s);
  close(p);
  close(c);
}
/* The bound is the WHOLE TURN's stdout, and a worker can cross it while it is
   still working and still writing. `output_boundary_case` writes one byte past
   the bound and then exits on its own account, so it proves the arithmetic and
   not the termination: the worker was already gone when the trip fired. This
   one straddles that boundary from the other side. The fixture writes eight
   times the bound in ordinary frame-sized writes and then sleeps far longer
   than this suite, so it fills its own pipe repeatedly and is asleep inside
   `write()` when the trip happens, and NOTHING but the launcher can end it.
   A launcher that stopped reading without killing — or killed without
   answering — parks the worker and this client forever, which is why the
   socket carries a deadline: a park has to fail red here, not hang the runner.
   The deadline also bounds the answer: it must arrive while the fixture is
   still sleeping, so a pass cannot be the fixture exiting by itself. */
static void worker_stream_case(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("stream-output", "mcp.Stream-2");
  struct dbl_request q = request();
  struct dbl_result r;
  struct timeval deadline = {.tv_sec = 30, .tv_usec = 0};
  char extra;
  check(!setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline)),
        "worker stream deadline");
  send_request(s, &q, p, c);
  check(read_all(s, &r, sizeof(r)) && result_padding_zero(&r),
        "worker stream answered before the deadline");
  check(r.status == DBL_STATUS_OUTPUT_FAILED && r.stage == DBL_STAGE_OUTPUT &&
            r.failure_class == DBL_FAILURE_OUTPUT_LIMIT &&
            r.output_length == 0 && r.diagnostic_length == 0 &&
            r.worker_pid > 0 && r.worker_uid == 2200 && r.start_ticks > 0 &&
            r.term_signal == SIGKILL,
        "worker stream stopped at the bound");
  check(read(s, &extra, 1) == 0, "worker stream EOF");
  close(s);
  close(p);
  close(c);
}
/* A worker that outlives its own stdout must not make the launcher spin.
   This is the observed production failure, and it is the one the escape cases
   below do NOT cover. Grok 1.0.34 closes its output and can stay alive; the read
   end of that pipe is then readable for ever and yields nothing, so a loop that
   only consumes POLLIN and only acts on a positive read consumed nothing and
   polled again, for ever. One handler was found after 25 hours in exactly that
   state — 87,000 seconds of CPU, two thirds of it in the kernel, with its worker
   alive and idle beside it and the turn already closed at the broker.

   The only observable that separates a fixed launcher from a wedged one while
   the worker is still alive is the handler's CPU: waiting in poll() burns
   nothing, spinning burns a core. So that is what this asserts, and it is why
   it reads /proc rather than the protocol.
   Mutations that turn it red: restore `p[1].events = 0` in place of
   `p[1].fd = -1`, or delete the `got == 0` branch. */
static void worker_eof_spin_case(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("eof-hang", "mcp.Eof-1");
  struct dbl_request q = request();
  struct dbl_result r;
  struct timeval deadline = {.tv_sec = 30, .tv_usec = 0};
  unsigned long before, after;
  pid_t handler;
  char extra;
  check(!setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline)),
        "eof spin deadline");
  send_request(s, &q, p, c);
  sleep(3); /* the worker has written, closed both descriptors and is sleeping */
  handler = worker_handler_pid(2200);
  check(handler > 1, "eof spin found the supervising handler");
  before = process_cpu_ticks(handler);
  sleep(2);
  after = process_cpu_ticks(handler);
  if (after - before >= 20)
    fprintf(stderr, "handler %ld burned %lu ticks in 2s while its worker sat at EOF\n",
            (long)handler, after - before);
  check(after - before < 20, "the launcher waits instead of spinning on a pipe at EOF");
  /* And the turn still ends, on the launcher's own ceiling, rather than hanging
     for as long as the worker feels like sleeping. */
  check(read_all(s, &r, sizeof(r)) && result_padding_zero(&r) &&
            r.status == DBL_STATUS_WORKER_FAILED && r.stage == DBL_STAGE_WAIT &&
            r.failure_class == DBL_FAILURE_WAIT && r.worker_pid > 0 &&
            r.worker_uid == 2200 && r.start_ticks > 0 && r.output_length == 0,
        "a worker at EOF is ended by the launcher, not waited on for ever");
  if (r.diagnostic_length) {
    char *reason = calloc(1, r.diagnostic_length + 1);
    check(reason && read_all(s, reason, r.diagnostic_length), "eof spin diagnostic");
    free(reason);
  }
  check(read(s, &extra, 1) == 0, "eof spin EOF");
  close(s);
  close(p);
  close(c);
  check_worker_identity_settled(2200, "a turn ended at EOF left nothing behind");
}
/* THE CEILING. A turn that never ends on its own account, with its output pipe
   still open so no other bound can trip, and a client that never disconnects.
   Before this the launcher had no deadline of its own and waited for ever; the
   whole point is that a turn now always reaches a terminal frame.
   The suite compiles the launcher with DBL_MAX_TURN_SECONDS=8 (see
   Dockerfile.integration) because it cannot wait 4200 seconds to prove a bound.
   Mutation: drop that -D and the fixture's 600-second sleep outlives the socket
   deadline, so the case fails red on a park instead of passing on a timeout. */
static void worker_ceiling_case(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("wall-hang", "mcp.Wall-1");
  struct dbl_request q = request();
  struct dbl_result r;
  struct timeval deadline = {.tv_sec = 30, .tv_usec = 0};
  time_t sent, answered;
  char extra;
  check(!setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline)),
        "ceiling deadline");
  sent = time(NULL);
  send_request(s, &q, p, c);
  check(read_all(s, &r, sizeof(r)) && result_padding_zero(&r),
        "the launcher answered a turn that would never end on its own");
  answered = time(NULL);
  check(r.status == DBL_STATUS_WORKER_FAILED && r.stage == DBL_STAGE_WAIT &&
            r.failure_class == DBL_FAILURE_WAIT && r.worker_pid > 0 &&
            r.worker_uid == 2200 && r.start_ticks > 0 && r.output_length == 0 &&
            r.term_signal == SIGKILL,
        "the ceiling reports a killed failed wait");
  /* Near the ceiling, not near the fixture's own sleep: a pass must be the
     launcher ending the turn, never the worker finishing by itself. */
  check(answered - sent < 20, "the ceiling ended the turn on its own clock");
  if (r.diagnostic_length) {
    char *reason = calloc(1, r.diagnostic_length + 1);
    check(reason && read_all(s, reason, r.diagnostic_length), "ceiling diagnostic");
    free(reason);
  }
  check(read(s, &extra, 1) == 0, "ceiling EOF");
  close(s);
  close(p);
  close(c);
  check_worker_identity_settled(2200, "a turn ended by the ceiling left nothing behind");
}
/* Defence in depth for the identity reap, honestly scoped.
   `supervise` also reaps every process owned by the worker's uid, because a
   process group is not a container in principle: one `setsid()` leaves a group
   and a session, and a double fork leaves no ancestry to walk. That reap is
   sound and it is shipped.
   But it is NOT the observed production failure, and this file used to imply it
   was. Real Grok 1.0.34 does not leave the group: its bubblewrap re-exec IS the
   process the launcher forked, pgid == pid, with the sandboxed CLI in the same
   group — measured on the live deployment. Three cases that reproduced an escape
   Grok does not perform read as coverage while proving nothing about the bug we
   actually had, which is why two of them are gone and the observed failure is
   covered by `worker_eof_spin_case` and `worker_ceiling_case` above.
   One escape case remains, on the cancellation path, as a guard against a future
   engine that does detach. It is defence in depth, not a regression test for
   something we have seen. */
/* The deadline path. A brokered turn that runs past its token, request or
   wall-clock limit is cancelled by killing the launcher's client, which
   arrives here as the client disconnect `supervise` also takes for an operator
   cancellation — so this is the timeout case, and it is the one that ran for
   48 minutes in production. The turn is closed only once the escapee exists
   and the identity demonstrably owns live processes, so it cannot pass by
   racing the worker to the socket. */
static void worker_escape_cancel_case(void) {
  int s = connect_socket(), p = sealed("prompt"),
      c = sealed_bundle("escape-cancel", "mcp.Escape-3");
  struct dbl_request q = request();
  long escaped = 0, group = 0, session = 0;
  send_request(s, &q, p, c);
  read_escape_marker("escape-cancel", &escaped, &group, &session);
  /* `setsid()` ran in the middle process, so the survivor's group and session
     are both that process and neither is the survivor itself: it is outside
     everything the launcher could name about the worker it forked. */
  check(escaped > 0 && group > 0 && group == session && group != escaped,
        "the cancelled turn's escapee left the worker's group and session");
  check(worker_identity_processes(2200) > 0,
        "the cancelled turn still owns processes at the moment it is cancelled");
  close(s);
  close(p);
  close(c);
  check_worker_identity_settled(2200, "cancelled turn left nothing behind");
}
/* THE ORPHANED CLIENT. The handler ends a turn when its client disconnects,
   and the broker always kills its `--client` when a turn ends — while the
   broker is alive. A broker that dies (crash, restart, OOM) leaves its
   `--client` children running: they are detached into their own session, so
   nothing reaches them, and each one holds its handler's socket open. The
   handler then sees a live client and keeps supervising a turn nobody will ever
   read. Before the launcher had a ceiling, a worker that closed its stdout and
   stayed alive (Grok does both) turned that into a handler spinning a full core
   for ever; the ceiling bounded it to DBL_MAX_TURN_SECONDS, which is still a
   process outliving its turn by up to seventy minutes.
   This stands in for the broker with a process that spawns `--client`, feeds it
   a turn that never ends on its own, and dies without cleaning up. The handler
   must be gone well inside the integration build's 8-second ceiling, so a pass
   cannot be the ceiling doing the work. */
/* Gone, or a zombie: an exited handler stays `<defunct>` until the launcher's
   accept loop next reaps, and that is not a handler that outlived anything. */
static int process_exited(pid_t pid) {
  char path[64], buffer[512], *cursor;
  int fd;
  ssize_t n;
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  fd = open(path, O_RDONLY);
  if (fd < 0)
    return errno == ENOENT;
  n = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);
  if (n < 1)
    return 1;
  buffer[n] = 0;
  cursor = strrchr(buffer, ')');
  return cursor && cursor[1] == ' ' && (cursor[2] == 'Z' || cursor[2] == 'X');
}
static void orphaned_client_case(void) {
  int input[2], ready[2], status;
  char go = 0;
  check(!pipe(input) && !pipe(ready), "orphan pipes");
  pid_t broker = fork();
  check(broker >= 0, "orphan broker fork");
  if (!broker) {
    close(ready[0]);
    pid_t client = fork();
    if (client < 0)
      _exit(90);
    if (!client) {
      int null_output = open("/dev/null", O_WRONLY);
      if (null_output < 0 || dup2(input[0], 0) < 0 || dup2(null_output, 1) < 0)
        _exit(91);
      close(input[1]);
      close(ready[1]);
      execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker",
            "--client", NULL);
      _exit(127);
    }
    close(input[0]);
    struct dbl_request request_value = request();
    unsigned char capability[DBL_MAX_CAPABILITY_BUNDLE];
    uint32_t capability_length =
        (uint32_t)make_bundle("wall-hang", "mcp.Orphan-1", capability);
    uint32_t prompt_length = 6;
    if (!write_all(input[1], &request_value, sizeof(request_value)) ||
        !write_all(input[1], &prompt_length, sizeof(prompt_length)) ||
        !write_all(input[1], "prompt", prompt_length) ||
        !write_all(input[1], &capability_length, sizeof(capability_length)) ||
        !write_all(input[1], capability, capability_length))
      _exit(92);
    close(input[1]);
    if (write(ready[1], "r", 1) != 1)
      _exit(93);
    for (;;)
      pause(); /* dies only by the SIGKILL below, like a crashed broker */
  }
  close(input[0]);
  close(input[1]);
  close(ready[1]);
  check(read(ready[0], &go, 1) == 1 && go == 'r', "orphan broker fed its client");
  close(ready[0]);
  sleep(1); /* past the worker's own short-lived --auth-provider child */
  pid_t handler = -1;
  for (int attempt = 0; attempt < 250 && handler <= 1; attempt++) {
    handler = worker_handler_pid(2200);
    if (handler <= 1)
      usleep(20000);
  }
  check(handler > 1, "the orphaned turn's worker is running under its handler");
  check(!kill(broker, SIGKILL) && waitpid(broker, &status, 0) == broker,
        "the broker dies without ending its turn");
  int gone = 0;
  for (int attempt = 0; attempt < 150 && !gone; attempt++) {
    gone = process_exited(handler);
    if (!gone)
      usleep(20000);
  }
  if (!gone)
    fprintf(stderr, "handler %ld outlived its dead broker's turn\n", (long)handler);
  check(gone, "a handler exits with a turn whose broker died");
  check_worker_identity_settled(2200, "an orphaned turn left nothing behind");
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
  worker_spill_case();
  worker_turn_case();
  worker_stream_case();
  worker_eof_spin_case();
  worker_ceiling_case();
  worker_escape_cancel_case();
  orphaned_client_case();
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
  check_worker_identity_settled(2200, "disconnect cleanup");
}

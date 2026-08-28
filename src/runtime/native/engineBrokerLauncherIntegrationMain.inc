int main(void) {
  setbuf(stdout, NULL);
  alarm(40);
  check(sizeof(struct dbl_result) == DBL_RESULT_SIZE &&
            offsetof(struct dbl_result, stage) == DBL_RESULT_STAGE_OFFSET &&
            offsetof(struct dbl_result, failure_class) ==
                DBL_RESULT_FAILURE_CLASS_OFFSET &&
            offsetof(struct dbl_result, profile_applied) ==
                DBL_RESULT_PROFILE_APPLIED_OFFSET &&
            offsetof(struct dbl_result, reserved) == DBL_RESULT_RESERVED_OFFSET,
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
  if (!broker)
    execl("/opt/daimon/bin/daimon-engine-broker", "daimon-engine-broker", NULL);
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

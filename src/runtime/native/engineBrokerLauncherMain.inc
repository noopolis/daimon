int main(int argc, char **argv) {
  int s, c;
  pid_t handler;
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  mode_t old;
  if (argc == 2 && strcmp(argv[1], "--client") == 0)
    return client_mode() == 0 ? 0 : 111;
  if (argc == 2 && strcmp(argv[1], "--auth-provider") == 0)
    return auth_provider_mode() == 0 ? 0 : 111;
  if (argc == 2 && strcmp(argv[1], "--relay") == 0)
    return relay_mode() == 0 ? 0 : 111;
  if (argc != 1 || geteuid() != 0)
    return 111;
  if (strlen(DBL_SOCKET) >= sizeof(a.sun_path))
    return 111;
  memcpy(a.sun_path, DBL_SOCKET, sizeof(DBL_SOCKET));
  s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (s < 0)
    return 111;
  unlink(DBL_SOCKET);
  old = umask(0007);
  if (bind(s, (struct sockaddr *)&a,
           offsetof(struct sockaddr_un, sun_path) + strlen(a.sun_path) + 1) ||
      chown(DBL_SOCKET, 0, DBL_BROKER_UID) || chmod(DBL_SOCKET, 0660) ||
      listen(s, 16))
    die();
  umask(old);
  for (;;) {
    c = accept4(s, NULL, NULL, SOCK_CLOEXEC);
    if (c < 0) {
      if (errno == EINTR)
        continue;
      die();
    }
    handler = fork();
    if (handler < 0) {
      close(c);
      continue;
    }
    if (handler == 0) {
      if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() == 1)
        die();
      close(s);
      serve(c);
      close(c);
      _exit(0);
    }
    close(c);
    while (waitpid(-1, NULL, WNOHANG) > 0) {
    }
  }
}

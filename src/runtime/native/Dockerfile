FROM gcc:14-bookworm@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15
COPY engineBrokerLauncher.c engineBrokerLauncher.h engineBrokerLauncherCore.inc engineBrokerLauncherServer.inc engineBrokerLauncherModes.inc engineBrokerLauncherMain.inc /src/
RUN gcc -std=c17 -Wall -Wextra -Werror -Wno-deprecated-declarations -O2 -fPIE -pie -Wl,-z,relro,-z,now \
  -o /daimon-engine-broker /src/engineBrokerLauncher.c -Wl,-Bstatic -lcrypto -Wl,-Bdynamic && strip /daimon-engine-broker

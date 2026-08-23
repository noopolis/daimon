import type {
  OrganizationRuntimeActivityPage,
  OrganizationRuntimeActivity,
  OrganizationRuntimeActivityRequest,
  OrganizationRuntimeAgentHealth,
  OrganizationRuntimeHealth,
  OrganizationRuntimeHost,
  OrganizationRuntimeShutdownCompletion,
  OrganizationRuntimeWakeRequest,
  OrganizationRuntimeWakeEvent,
  OrganizationRuntimeWakeResult
} from "./organizationRuntime.js";
import type { OrganizationRuntimeConfig } from "./organizationRuntime.js";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ?
    ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false) : false;

type StartSignature = Assert<IsEqual<OrganizationRuntimeHost["start"], () => Promise<void>>>;
type WakeSignature = Assert<IsEqual<OrganizationRuntimeHost["wake"], (request: OrganizationRuntimeWakeRequest) => Promise<OrganizationRuntimeWakeResult>>>;
type HealthSignature = Assert<IsEqual<OrganizationRuntimeHost["health"], (agentId?: string) => Promise<OrganizationRuntimeHealth>>>;
type ActivitySignature = Assert<IsEqual<OrganizationRuntimeHost["activity"], (request: OrganizationRuntimeActivityRequest) => Promise<OrganizationRuntimeActivityPage>>>;
type StopSignature = Assert<IsEqual<OrganizationRuntimeHost["stop"], () => Promise<OrganizationRuntimeShutdownCompletion>>>;

const start: StartSignature = true;
const wake: WakeSignature = true;
const health: HealthSignature = true;
const activity: ActivitySignature = true;
const stop: StopSignature = true;
void [start, wake, health, activity, stop];

function configIsReadonly(config: OrganizationRuntimeConfig): void {
  // @ts-expect-error configuration is immutable at every public level.
  config.host.port = 9;
  // @ts-expect-error agent records are immutable.
  config.agents[0].name = "different";
}
void configIsReadonly;

function allPublicPayloadsAreReadonly(
  event: OrganizationRuntimeWakeEvent,
  request: OrganizationRuntimeWakeRequest,
  agentHealth: OrganizationRuntimeAgentHealth,
  healthValue: OrganizationRuntimeHealth,
  activityValue: OrganizationRuntimeActivity,
  activityPage: OrganizationRuntimeActivityPage,
  shutdown: OrganizationRuntimeShutdownCompletion
): void {
  // @ts-expect-error
  event.text = "x";
  // @ts-expect-error
  request.agentId = "x";
  // @ts-expect-error
  agentHealth.state = "failed";
  // @ts-expect-error
  healthValue.agents[0].state = "failed";
  // @ts-expect-error
  activityValue.kind = "agent_stopped";
  // @ts-expect-error
  activityPage.items[0].id = "x";
  // @ts-expect-error
  shutdown.state = "stopped";
}
void allPublicPayloadsAreReadonly;

function exhaustiveWakeResult(result: OrganizationRuntimeWakeResult): string {
  switch (result.status) {
    case "completed": return result.text;
    case "rejected": return result.code;
    case "stopped": return result.code;
    case "failed": return result.code;
    default: {
      const impossible: never = result;
      return impossible;
    }
  }
}
void exhaustiveWakeResult;

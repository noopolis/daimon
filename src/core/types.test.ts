import { strict as assert } from "node:assert";

import type { WakeDeliveryMetadata, WakeEvent } from "./types.js";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type DeliveryKeys = keyof WakeDeliveryMetadata;
type DeliveryHasClosedShape = Assert<
  IsEqual<DeliveryKeys, "eventId" | "sender" | "target" | "contextId">
>;
type DeliveryHasNoStringIndex = Assert<(string extends DeliveryKeys ? false : true)>;
type DeliveryWithoutExtras = Assert<
  IsEqual<Omit<WakeDeliveryMetadata, never>, WakeDeliveryMetadata>
>;
type DeliveryMissingContextIdIsInvalid = Assert<
  ({ eventId: string; sender: string; target: string } extends WakeDeliveryMetadata
    ? false
    : true)
>;
type DeliveryMissingEventIdIsInvalid = Assert<
  ({ sender: string; target: string; contextId: string } extends WakeDeliveryMetadata
    ? false
    : true)
>;
type DeliveryMissingSenderIsInvalid = Assert<
  ({ eventId: string; target: string; contextId: string } extends WakeDeliveryMetadata
    ? false
    : true)
>;
type DeliveryMissingTargetIsInvalid = Assert<
  ({ eventId: string; sender: string; contextId: string } extends WakeDeliveryMetadata
    ? false
    : true)
>;

type LegacyWakeDeliveryIsOptional = Assert<
  IsEqual<WakeEvent["delivery"], WakeDeliveryMetadata | undefined>
>;

const _deliveryShapeCheck: DeliveryHasClosedShape = true;
const _deliveryNoIndex: DeliveryHasNoStringIndex = true;
const _legacyWakeHasNoExtras: DeliveryWithoutExtras = true;
const _missingContextId: DeliveryMissingContextIdIsInvalid = true;
const _missingEventId: DeliveryMissingEventIdIsInvalid = true;
const _missingSender: DeliveryMissingSenderIsInvalid = true;
const _missingTarget: DeliveryMissingTargetIsInvalid = true;
const _deliveryOptional: LegacyWakeDeliveryIsOptional = true;

const legacyEvent: WakeEvent = {
  id: "evt-legacy-01",
  kind: "manual",
  text: "Manual wake payload"
};

const deliveredEvent: WakeEvent = {
  id: "evt-delivery-01",
  kind: "message",
  from: "alice",
  text: "Message wake payload",
  context: {
    networkId: "net",
    roomId: "room",
    teamId: "team"
  },
  delivery: {
    eventId: "moltnet:event-01",
    sender: "alice",
    target: "bob",
    contextId: "ctx-01"
  }
};

const expectedDelivery: WakeDeliveryMetadata = {
  eventId: "moltnet:event-01",
  sender: "alice",
  target: "bob",
  contextId: "ctx-01"
};

assert.equal(legacyEvent.id, "evt-legacy-01");
assert.equal(legacyEvent.kind, "manual");
assert.equal(legacyEvent.text, "Manual wake payload");
assert.equal(deliveredEvent.delivery?.eventId, expectedDelivery.eventId);
assert.equal(deliveredEvent.delivery?.sender, expectedDelivery.sender);
assert.equal(deliveredEvent.delivery?.target, expectedDelivery.target);
assert.equal(deliveredEvent.delivery?.contextId, expectedDelivery.contextId);

const reserialized: WakeEvent = {
  ...deliveredEvent,
  delivery: { ...deliveredEvent.delivery }
};

assert.deepEqual(reserialized.delivery, expectedDelivery);

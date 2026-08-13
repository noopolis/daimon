import {
  AuthStorage,
  ModelRegistry
} from "@earendil-works/pi-coding-agent";

import type { HarnessModelSpec } from "../core/types.js";

import { resolvePiHarnessModel } from "./modelConfig.js";

export interface PiModelRegistryOptions {
  model?: {
    auth?: HarnessModelSpec["auth"];
    endpoint?: HarnessModelSpec["endpoint"];
    provider: string;
    name: string;
  };
  modelsPath?: string;
}

export const createPiModelRegistry = (
  authStorage: AuthStorage,
  options: PiModelRegistryOptions
): ModelRegistry => {
  const registry = options.modelsPath
    ? ModelRegistry.create(authStorage, options.modelsPath)
    : ModelRegistry.inMemory(authStorage);

  if (!options.modelsPath && options.model?.endpoint) {
    const { modelsConfig } = resolvePiHarnessModel(options.model);
    for (const [provider, config] of Object.entries(modelsConfig.providers)) {
      registry.registerProvider(provider, {
        api: config.api,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        models: config.models
      });
    }
  }

  return registry;
};

import type { Api, Model } from "@earendil-works/pi-ai";

export function configureModel(
  model: Model<Api>,
  limits: { contextWindow: number; maxTokens: number },
): Model<Api> {
  return {
    ...model,
    contextWindow: Math.min(model.contextWindow, limits.contextWindow),
    maxTokens: Math.min(model.maxTokens, limits.maxTokens),
  };
}

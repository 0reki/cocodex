import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { registerPublicOpenAIRoutes } from "../src/server/routes/openai/public-openai-routes.ts";
import { createModelServices } from "../src/server/services/openai/model-services.ts";

async function requestModels(t, models) {
  const upstream = { models, catalog_version: "fixture-version" };
  const snapshot = structuredClone(upstream);
  const app = express();
  registerPublicOpenAIRoutes(app, {
    authenticateApiKeyWithReason: async () => ({
      apiKey: { ownerUserId: "fixture-user" },
    }),
    isApiKeyBoundToUser: () => true,
    getAssignedSourceAccount: async (ownerUserId) => {
      assert.equal(ownerUserId, "fixture-user");
      return { status: "active", accessToken: "fixture-token" };
    },
    resolveOpenAIUpstreamAccountId: () => "fixture-account",
    getOpenAIApiRuntimeConfig: async () => ({}),
    getCodexModelsWithTokenRefresh: async () => upstream,
    buildOpenAIModelsList: createModelServices({ modelPricing: [] }).buildOpenAIModelsList,
    extractErrorInfo: (error) => ({ status: 500, message: error.message }),
    buildPassthroughUpstreamError: ({ status, fallbackMessage }) => ({
      status,
      error: { message: fallbackMessage },
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/v1/models?client_version=0.153.4`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(upstream, snapshot);
  return response.json();
}

test("models endpoint exposes Spark to API-key pickers without changing other metadata", async (t) => {
  const spark = {
    slug: "gpt-5.3-codex-spark",
    visibility: "list",
    supported_in_api: false,
    input_modalities: ["text"],
    context_window: 128000,
  };
  const astra = { slug: "gpt-6-astra", visibility: "list", supported_in_api: true };
  const restricted = { slug: "other-model", visibility: "hide", supported_in_api: false };
  const response = await requestModels(t, [spark, astra, restricted]);
  assert.deepEqual(response.models, [
    { ...spark, supported_in_api: true }, astra, restricted,
  ]);
  assert.equal(response.catalog_version, "fixture-version");
  assert.equal(response.object, "list");
  assert.deepEqual(response.data.map((model) => model.id), [
    "gpt-5.3-codex-spark", "gpt-6-astra", "other-model",
  ]);
});

test("models endpoint does not invent Spark when upstream omits it", async (t) => {
  const models = [{ slug: "gpt-6-astra", visibility: "list", supported_in_api: true }];
  const response = await requestModels(t, models);
  assert.deepEqual(response.models, models);
  assert.deepEqual(response.data.map((model) => model.id), ["gpt-6-astra"]);
});

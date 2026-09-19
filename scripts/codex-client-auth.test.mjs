import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCodexBackendForward,
  isCodexBackendApiPath,
  isCodexResponsesPath,
} from "../src/server/utils/openai/codex-backend-alias.ts";

test("codex backend paths stay on the subscription prefix", () => {
  assert.equal(isCodexBackendApiPath("/backend-api/codex/responses"), true);
  assert.equal(isCodexBackendApiPath("/backend-api/codex/models"), true);
  assert.equal(isCodexBackendApiPath("/v1/responses"), false);
  assert.equal(isCodexResponsesPath("/backend-api/codex/responses"), true);
  assert.equal(isCodexResponsesPath("/v1/responses"), false);
  assert.equal(classifyCodexBackendForward("/backend-api/codex/responses"), "responses");
  assert.equal(classifyCodexBackendForward("/backend-api/codex/images/generations"), "images");
  assert.equal(classifyCodexBackendForward("/backend-api/codex/alpha/search"), "search");
  assert.equal(classifyCodexBackendForward("/backend-api/codex/models"), "passthrough");
});

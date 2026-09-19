import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";

import { startNodeIpcServer } from "../src/server/ipc/uds-server.ts";

test("Node IPC UDS server handles ping and parse error", async () => {
  const socketPath = path.resolve(process.cwd(), "data", `test-ipc-${Date.now()}.sock`);
  const server = await startNodeIpcServer({ socketPath });

  try {
    const client = net.createConnection(socketPath);
    await new Promise((resolve) => client.once("connect", resolve));

    // Send ping
    const req = JSON.stringify({ id: "test-1", method: "health.ping", params: {} }) + "\n";
    client.write(req);

    const responseLine = await new Promise((resolve) => {
      let buffer = "";
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) {
          resolve(buffer.trim());
        }
      });
    });

    const parsed = JSON.parse(responseLine);
    assert.equal(parsed.id, "test-1");
    assert.equal(parsed.result?.ok, true);
    assert.ok(typeof parsed.result?.timestamp === "number");

    client.destroy();
  } finally {
    await server.close();
    assert.equal(fs.existsSync(socketPath), false);
  }
});

function sendRpcLine(client, payload) {
  client.write(JSON.stringify(payload) + "\n");
}

test("upstream.resolve_account rejects missing platform with an RPC error", async () => {
  const socketPath = path.resolve(process.cwd(), "data", `test-ipc-resolve-${Date.now()}.sock`);
  const server = await startNodeIpcServer({ socketPath });

  try {
    const client = net.createConnection(socketPath);
    await new Promise((resolve) => client.once("connect", resolve));

    const responseLine = await new Promise((resolve) => {
      let buffer = "";
      sendRpcLine(client, { id: "resolve-1", method: "upstream.resolve_account", params: {} });
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) {
          resolve(buffer.trim());
        }
      });
    });

    const parsed = JSON.parse(responseLine);
    assert.equal(parsed.id, "resolve-1");
    assert.equal(parsed.result, undefined);
    assert.equal(parsed.error?.code, -32603);
    assert.equal(parsed.error?.message, "platform is required");

    client.destroy();
  } finally {
    await server.close();
    assert.equal(fs.existsSync(socketPath), false);
  }
});


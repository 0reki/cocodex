import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { startNodeIpcServer } from "../src/server/ipc/uds-server.ts";

test("End-to-End: Rust Proxy + Node UDS IPC authentication integration", async () => {
  const socketPath = path.resolve(process.cwd(), "data", `test-full-ipc-${Date.now()}.sock`);
  const proxyPort = 53199;
  const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;

  // 1. Start Node UDS server
  const nodeIpc = await startNodeIpcServer({ socketPath });

  // 2. Spawn Rust Proxy binary
  const proxyBinary = path.resolve(process.cwd(), "crates/proxy/target/debug/cocodex-proxy");
  assert.ok(fs.existsSync(proxyBinary), "Rust proxy binary should exist");

  const proxyProcess = spawn(
    proxyBinary,
    [],
    {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PROXY_PORT: String(proxyPort),
        NODE_BACKEND_URL: "http://127.0.0.1:53198",
        COCODEX_IPC_SOCKET_PATH: socketPath,
        PUBLIC_APP_URL: "http://localhost:53332",
        RUST_LOG: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let proxyOutput = "";
  proxyProcess.stdout.on("data", (d) => { proxyOutput += d.toString(); });
  proxyProcess.stderr.on("data", (d) => { proxyOutput += d.toString(); });

  try {
    // Wait for proxy to listen
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${proxyBaseUrl}/oauth/authorize`, { redirect: "manual" });
        if (res.status === 307) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(ready, `Proxy did not become ready in time. Log:\n${proxyOutput}`);

    // Step 1: Request device code
    const userCodeRes = await fetch(`${proxyBaseUrl}/api/accounts/deviceauth/usercode`, {
      method: "POST",
    });
    assert.equal(userCodeRes.status, 200);
    const userCodeBody = await userCodeRes.json();
    assert.ok(typeof userCodeBody.device_auth_id === "string");
    assert.ok(typeof userCodeBody.user_code === "string");
    assert.equal(userCodeBody.user_code.length, 9);
    assert.equal(userCodeBody.interval, "5");

    // Step 2: Poll before approval -> 403 authorization_pending
    const pollPendingRes = await fetch(`${proxyBaseUrl}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: userCodeBody.device_auth_id,
        user_code: userCodeBody.user_code,
      }),
    });
    assert.equal(pollPendingRes.status, 403);
    const pollPendingBody = await pollPendingRes.json();
    assert.equal(pollPendingBody.error, "authorization_pending");

    // Step 3: OAuth redirect test
    const authRedirectRes = await fetch(
      `${proxyBaseUrl}/oauth/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A14555%2Fcallback&code_challenge=test_challenge&state=state123`,
      { redirect: "manual" },
    );
    assert.equal(authRedirectRes.status, 307);
    const location = authRedirectRes.headers.get("location");
    assert.ok(location.startsWith("http://localhost:53332/login?next="));
    assert.ok(location.includes(encodeURIComponent("/oauth/complete?")));

    // Step 4: Device callback 204
    const callbackRes = await fetch(`${proxyBaseUrl}/deviceauth/callback`);
    assert.equal(callbackRes.status, 204);

    console.log("✓ Rust proxy and Node UDS integration verified successfully");
  } finally {
    proxyProcess.kill("SIGTERM");
    await new Promise((r) => proxyProcess.once("exit", r));
    await nodeIpc.close();
  }
});


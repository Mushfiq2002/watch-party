import { spawn } from "node:child_process";

const origin = "http://127.0.0.1:5199";
const server = spawn(
  "npm",
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5199"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let serverOutput = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    serverOutput += chunk;
    if (serverOutput.length > 20_000) {
      serverOutput = serverOutput.slice(-20_000);
    }
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Development server stopped early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Development server did not become ready.\n${serverOutput}`);
}

function runSmokeTest() {
  return new Promise((resolve, reject) => {
    const test = spawn(process.execPath, ["scripts/backend-smoke.mjs", origin], {
      stdio: "inherit",
    });
    test.once("error", reject);
    test.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Backend smoke test exited with ${code ?? signal}`));
      }
    });
  });
}

try {
  await waitUntilReady();
  await runSmokeTest();
} finally {
  server.kill("SIGTERM");
}

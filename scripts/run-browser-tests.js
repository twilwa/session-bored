// ABOUTME: Runs the browser suite with one CI-only recovery for a dead managed web server.
// ABOUTME: Leaves ordinary test and assertion failures non-retriable so they remain trustworthy.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MAX_CAPTURE_LENGTH = 1_000_000;

export function isWebServerFailure(output) {
  return (
    /Could not connect to 127\.0\.0\.1(?::\d+)?: Connection refused/i.test(output) ||
    /page\.goto: Could not connect to the server\./i.test(output) ||
    /net::ERR_CONNECTION_REFUSED/i.test(output) ||
    /Process from config\.webServer[^\n]*(?:exited|exit code)/i.test(output)
  );
}

function appendRecentOutput(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_CAPTURE_LENGTH);
}

function runBrowserTestsOnce() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    npmCommand,
    ["run", "test:e2e", "--", "--reporter=line,html"],
    { env: process.env, stdio: ["inherit", "pipe", "pipe"] },
  );

  let output = "";
  const relay = (destination, chunk) => {
    destination.write(chunk);
    output = appendRecentOutput(output, chunk.toString());
  };

  child.stdout.on("data", (chunk) => relay(process.stdout, chunk));
  child.stderr.on("data", (chunk) => relay(process.stderr, chunk));

  return new Promise((resolveRun) => {
    child.on("error", (error) => {
      const message = `Unable to launch browser tests: ${error.message}\n`;
      process.stderr.write(message);
      output = appendRecentOutput(output, message);
      resolveRun({ code: 1, output });
    });
    child.on("close", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

async function runBrowserTests() {
  const firstRun = await runBrowserTestsOnce();
  if (firstRun.code === 0) return 0;

  const serverRetryLimit = process.env.CI ? 1 : 0;
  if (serverRetryLimit === 0 || !isWebServerFailure(firstRun.output)) return firstRun.code;

  process.stderr.write(
    "Managed browser web server died; restarting the browser run once. Assertion failures are not retried.\n",
  );
  const recoveryRun = await runBrowserTestsOnce();
  return recoveryRun.code;
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) process.exitCode = await runBrowserTests();

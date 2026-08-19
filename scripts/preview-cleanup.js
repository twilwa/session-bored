// ABOUTME: Reclaims the R2 bucket and D1 database owned by one pull request preview.
// ABOUTME: Deletes R2 objects first so a failed cleanup keeps the database metadata needed to retry.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const objectKeysSql = [
  "select storage_key as object_key from file_version",
  "union select 'events/' || id || '/branding/background' as object_key from event",
  "union select 'events/' || id || '/branding/logo' as object_key from event",
  "order by object_key",
].join(" ");

function previewNumber(databaseName, bucketName) {
  const databaseMatch = /^session-bored-pr-([1-9][0-9]*)$/.exec(databaseName);
  const bucketMatch = /^session-bored-pr-([1-9][0-9]*)-files$/.exec(bucketName);
  if (databaseMatch === null || bucketMatch === null || databaseMatch[1] !== bucketMatch[1]) {
    throw new Error(`Unsafe preview resource names: ${databaseName}, ${bucketName}`);
  }
  return databaseMatch[1];
}

function objectKeysFrom(output) {
  const executions = JSON.parse(output);
  if (!Array.isArray(executions) || executions.some((execution) => execution.success !== true)) {
    throw new Error("Wrangler did not return a successful preview object inventory");
  }
  return executions.flatMap((execution) => execution.results ?? []).map((row) => row.object_key);
}

function runWrangler(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}

export function cleanupPreviewResources({
  databaseName,
  bucketName,
  databaseExists,
  bucketExists,
  runCommand = runWrangler,
}) {
  previewNumber(databaseName, bucketName);

  if (bucketExists) {
    if (databaseExists) {
      const inventory = runCommand("npx", [
        "wrangler", "d1", "execute", databaseName, "--remote", "--json", "--command", objectKeysSql,
      ]);
      for (const objectKey of objectKeysFrom(inventory)) {
        runCommand("npx", [
          "wrangler", "r2", "object", "delete", `${bucketName}/${objectKey}`, "--remote",
        ]);
      }
    }
    runCommand("npx", ["wrangler", "r2", "bucket", "delete", bucketName]);
  }

  if (databaseExists) {
    runCommand("npx", ["wrangler", "d1", "delete", databaseName, "--skip-confirmation"]);
  }
}

function cleanupFromEnvironment() {
  cleanupPreviewResources({
    databaseName: process.env.DATABASE_NAME ?? "",
    bucketName: process.env.BUCKET_NAME ?? "",
    databaseExists: process.env.DATABASE_EXISTS === "true",
    bucketExists: process.env.BUCKET_EXISTS === "true",
  });
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) cleanupFromEnvironment();

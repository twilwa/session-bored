// ABOUTME: Builds the Cloudflare config a pull request preview deploys against.
// ABOUTME: Binds the Worker to that pull request's own D1 database, R2 bucket, and origin.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function buildPreviewConfig(source, { databaseName, databaseId, bucketName, previewUrl }) {
  const missing = Object.entries({ databaseName, databaseId, bucketName, previewUrl })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Preview config is missing ${missing.join(", ")}`);
  }

  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  config.preview_urls = true;
  config.d1_databases[0].database_name = databaseName;
  config.d1_databases[0].database_id = databaseId;
  config.r2_buckets[0].bucket_name = bucketName;
  config.vars.APP_ORIGIN = previewUrl;
  return config;
}

function writePreviewConfig() {
  const config = buildPreviewConfig(readFileSync("wrangler.jsonc", "utf8"), {
    databaseName: process.env.DATABASE_NAME,
    databaseId: process.env.DATABASE_ID,
    bucketName: process.env.BUCKET_NAME,
    previewUrl: process.env.PREVIEW_URL,
  });
  writeFileSync(".wrangler-preview.json", JSON.stringify(config, null, 2));
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) writePreviewConfig();

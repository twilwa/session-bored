// ABOUTME: Confirms whether one pull request preview owns an R2 bucket through Cloudflare's API.
// ABOUTME: Reports absence only for a not-found response and fails closed for every lookup error.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function previewBucketExists({ accountId, apiToken, bucketName, request = fetch }) {
  if (!accountId || !apiToken || !/^session-bored-pr-[1-9][0-9]*-files$/.test(bucketName)) {
    throw new Error("Preview bucket lookup requires safe resource names and Cloudflare credentials");
  }

  const response = await request(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Cloudflare R2 bucket lookup failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (
    payload === null
    || typeof payload !== "object"
    || payload.success !== true
    || payload.result?.name !== bucketName
  ) {
    throw new Error("Cloudflare returned an unexpected preview bucket lookup response");
  }
  return true;
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  console.log(await previewBucketExists({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    bucketName: process.env.BUCKET_NAME ?? "",
  }));
}

// ABOUTME: Describes the fail-closed preview bucket lookup consumed by workflow tests.
// ABOUTME: Keeps the Cloudflare request seam explicit for deterministic unit coverage.
export function previewBucketExists(options: {
  accountId: string | undefined;
  apiToken: string | undefined;
  bucketName: string;
  request?: typeof fetch;
}): Promise<boolean>;

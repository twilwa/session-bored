// ABOUTME: Describes the preview Cloudflare config builder consumed by the unit suite.
// ABOUTME: Keeps the executable JavaScript entry point type-safe for TypeScript importers.
export function buildPreviewConfig(
  source: string,
  bindings: {
    databaseName: string | undefined;
    databaseId: string | undefined;
    bucketName: string | undefined;
    previewUrl: string | undefined;
  },
): {
  preview_urls: boolean;
  d1_databases: { binding: string; database_name: string; database_id: string }[];
  r2_buckets: { binding: string; bucket_name: string }[];
  vars: { APP_ORIGIN: string };
};

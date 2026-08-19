// ABOUTME: Describes the preview resource cleanup entry point consumed by the unit suite.
// ABOUTME: Keeps cleanup dependencies explicit while the executable remains plain JavaScript.
export function cleanupPreviewResources(options: {
  databaseName: string;
  bucketName: string;
  databaseExists: boolean;
  bucketExists: boolean;
  runCommand?: (command: string, args: string[]) => string;
}): void;

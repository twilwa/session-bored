// ABOUTME: Recovers the filename a speaker uploaded for one stored version of a file.
// ABOUTME: Each version keeps its own name in its storage key, while file.displayName tracks the newest.
/**
 * Storage keys are built as `.../{fileVersionId}-{sanitized filename}`, so a superseded
 * version can still be downloaded and listed under the name it was uploaded with rather
 * than under the name of whatever replaced it.
 */
export function filenameForVersion(
  version: { id: string; storageKey: string },
  fallback: string,
): string {
  const objectName = version.storageKey.slice(version.storageKey.lastIndexOf("/") + 1);
  const prefix = `${version.id}-`;
  return objectName.startsWith(prefix) && objectName.length > prefix.length
    ? objectName.slice(prefix.length)
    : fallback;
}

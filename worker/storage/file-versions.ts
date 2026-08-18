// ABOUTME: Describes downloadable file versions with their original names and history status.
// ABOUTME: Keeps organizer and speaker file-history responses on one shared contract.
import type { PortalFileVersion } from "../../shared/api.ts";

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

export function fileVersionSummary(
  version: {
    id: string;
    fileId: string;
    version: number;
    storageKey: string;
    sizeBytes: number;
    latest: boolean;
    uploadedAt: Date | string;
  },
  fallbackDisplayName: string,
  eventId: string,
  supersededByMerge: boolean,
): PortalFileVersion {
  return {
    version: version.version,
    displayName: filenameForVersion(version, fallbackDisplayName),
    sizeBytes: version.sizeBytes,
    uploadedAt: version.uploadedAt instanceof Date ? version.uploadedAt.toISOString() : version.uploadedAt,
    current: version.latest,
    supersededByMerge,
    downloadUrl: `/api/portal/files/${version.fileId}?version=${version.version}&eventId=${encodeURIComponent(eventId)}`,
  };
}

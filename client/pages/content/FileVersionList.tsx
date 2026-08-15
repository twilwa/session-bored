// ABOUTME: Renders the current upload metadata and every downloadable superseded file version.
// ABOUTME: Keeps organizer and speaker file histories on one shared presentation contract.
import type { PortalFileVersion } from "../../../shared/api.ts";
import "./file-versions.css";

export function formatUploadedAt(uploadedAt: string): string {
  return new Date(uploadedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileVersionList({ versions }: { versions: PortalFileVersion[] }) {
  const current = versions.find((version) => version.current) ?? null;
  const superseded = versions.filter((version) => !version.current);
  return (
    <>
      {current === null ? null : (
        <small className="file-history__meta">
          Uploaded {formatUploadedAt(current.uploadedAt)} · {formatFileSize(current.sizeBytes)}
        </small>
      )}
      {superseded.length === 0 ? null : (
        <details className="file-versions" open>
          <summary>{superseded.length === 1 ? "1 earlier version" : `${superseded.length} earlier versions`}</summary>
          <ol>
            {superseded.map((version) => (
              <li key={version.version}>
                <a href={version.downloadUrl}>Version {version.version} · {version.displayName}</a>
                <small>Uploaded {formatUploadedAt(version.uploadedAt)} · {formatFileSize(version.sizeBytes)}</small>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

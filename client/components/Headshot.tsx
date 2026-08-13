// ABOUTME: Renders a speaker headshot and replaces a failed image with the speaker's initials.
// ABOUTME: Keeps every audience surface honest when a stored image cannot be displayed.
import { useEffect, useState, type CSSProperties } from "react";

// The one initials derivation for every headshot fallback: first + last word
// initials for multi-word names, the first two letters of a single-word name,
// and an empty badge for an all-whitespace name. Surfaces differ in sizing only.
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function headshotDisplay(name: string, url: string | null, failed: boolean): { initials: string; kind: "initials" } | { kind: "photo"; src: string } {
  if (url === null || url === "" || failed) {
    return { initials: initialsOf(name), kind: "initials" };
  }
  return { kind: "photo", src: url };
}

export function Headshot({
  alt,
  fallbackAriaLabel,
  fallbackClassName,
  imageClassName,
  imageStyle,
  loading,
  name,
  url,
}: {
  alt: string;
  fallbackAriaLabel?: string;
  fallbackClassName: string;
  imageClassName: string;
  imageStyle?: CSSProperties;
  loading?: "eager" | "lazy";
  name: string;
  url: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const display = headshotDisplay(name, url, failed);
  if (display.kind === "initials") {
    return fallbackAriaLabel === undefined
      ? <span aria-hidden="true" className={fallbackClassName}>{display.initials}</span>
      : <span aria-label={fallbackAriaLabel} className={fallbackClassName} role="img">{display.initials}</span>;
  }
  return <img alt={alt} aria-hidden={alt === "" ? true : undefined} className={imageClassName} loading={loading} onError={() => setFailed(true)} src={display.src} style={imageStyle} />;
}

// ABOUTME: Serializes organizer export records into durable interchange documents.
// ABOUTME: Produces RFC-compatible CSV cells without losing multiline committee text.
export type CsvCell = string | number | boolean | null | undefined;

function serializeCsvCell(value: CsvCell): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeCsv(headers: string[], rows: CsvCell[][]): string {
  return [headers, ...rows]
    .map((row) => row.map(serializeCsvCell).join(","))
    .join("\r\n") + "\r\n";
}

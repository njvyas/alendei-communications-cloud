import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import { AppException } from '../common/errors/app.exception';

/**
 * RFC 4180 compliant CSV parser and serializer.
 * Zero external CVE surface, strict quote and delimiter handling.
 */

/**
 * Parses RFC 4180 CSV text into a 2D array of strings.
 * Throws 400 CSV_MALFORMED on unclosed quotes or syntax errors.
 */
export function parseCsv(text: string): string[][] {
  // Strip UTF-8 BOM if present
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) {
    input = input.slice(1);
  }

  const resultList: string[][] = [];
  let currentRecord: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        // Lookahead for escaped quote `""`
        if (i + 1 < len && input[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      // Not in quotes
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === ',') {
        currentRecord.push(currentField);
        currentField = '';
        i++;
        continue;
      } else if (char === '\r') {
        // CRLF check
        if (i + 1 < len && input[i + 1] === '\n') {
          i++;
        }
        currentRecord.push(currentField);
        resultList.push(currentRecord);
        currentRecord = [];
        currentField = '';
        i++;
        continue;
      } else if (char === '\n') {
        currentRecord.push(currentField);
        resultList.push(currentRecord);
        currentRecord = [];
        currentField = '';
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  if (inQuotes) {
    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.CSV_MALFORMED,
      message: 'Malformed CSV: unclosed quote detected',
    });
  }

  // Push final field/record if input did not end with newline
  if (currentField.length > 0 || currentRecord.length > 0) {
    currentRecord.push(currentField);
    resultList.push(currentRecord);
  }

  // Discard empty trailing record (e.g. single trailing newline at EOF)
  if (resultList.length > 0) {
    const lastRecord = resultList[resultList.length - 1];
    if (lastRecord && lastRecord.length === 1 && lastRecord[0] === '') {
      resultList.pop();
    }
  }

  return resultList;
}

/**
 * Serializes a single row of cells into an RFC 4180 CSV line.
 */
export function serializeCsvRow(
  cells: readonly (string | number | boolean | null | undefined)[],
): string {
  return cells
    .map((cell) => {
      if (cell === null || cell === undefined) {
        return '';
      }
      const str = String(cell);
      if (str.includes('"') || str.includes(',') || str.includes('\r') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    })
    .join(',');
}

export interface ParsedCsvRow {
  readonly rowNumber: number;
  readonly data: Record<string, string>;
}

export interface ParsedCsvResult {
  readonly headers: readonly string[];
  readonly records: readonly ParsedCsvRow[];
}

/**
 * Parses CSV text and maps entries to objects keyed by header names.
 */
export function parseCsvToObjects(text: string): ParsedCsvResult {
  const rawList = parseCsv(text);
  if (rawList.length === 0) {
    return { headers: [], records: [] };
  }

  const rawHeaders = rawList[0];
  if (!rawHeaders) {
    return { headers: [], records: [] };
  }
  const headers = rawHeaders.map((h) => h.trim());

  const records: ParsedCsvRow[] = [];
  for (let idx = 1; idx < rawList.length; idx++) {
    const rawRow = rawList[idx];
    if (!rawRow) {
      continue;
    }
    // Skip empty lines in the middle
    if (rawRow.length === 1 && (rawRow[0] ?? '').trim() === '') {
      continue;
    }
    const data: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const headerName = headers[c];
      if (headerName) {
        data[headerName] = rawRow[c] !== undefined ? (rawRow[c] as string) : '';
      }
    }
    records.push({
      rowNumber: idx + 1, // 1-based, where row 1 was the header
      data,
    });
  }

  return { headers, records };
}

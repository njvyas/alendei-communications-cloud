import { ERROR_CODES } from '@acc/contracts';
import { parseCsv, parseCsvToObjects, serializeCsvRow } from './csv-parser';

describe('CSV Parser (RFC 4180)', () => {
  it('parses standard comma-separated values', () => {
    const csv = 'firstName,lastName,phone\nAlice,Smith,+15551234567\nBob,Jones,+15559876543';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['firstName', 'lastName', 'phone'],
      ['Alice', 'Smith', '+15551234567'],
      ['Bob', 'Jones', '+15559876543'],
    ]);
  });

  it('handles CRLF line breaks correctly', () => {
    const csv = 'col1,col2\r\nval1,val2\r\nval3,val4\r\n';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['col1', 'col2'],
      ['val1', 'val2'],
      ['val3', 'val4'],
    ]);
  });

  it('handles fields with commas and embedded newlines inside quotes', () => {
    const csv = 'id,note\n1,"Hello, World"\n2,"Multi-line\nNote"\n';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['id', 'note'],
      ['1', 'Hello, World'],
      ['2', 'Multi-line\nNote'],
    ]);
  });

  it('handles escaped quotes ("") correctly', () => {
    const csv = 'id,val\n1,"Quotes ""inside"" here"\n';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['id', 'val'],
      ['1', 'Quotes "inside" here'],
    ]);
  });

  it('strips UTF-8 BOM if present', () => {
    const csv = '\uFEFFname,score\nCharlie,100';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['name', 'score'],
      ['Charlie', '100'],
    ]);
  });

  it('throws 400 CSV_MALFORMED on unclosed quotes', () => {
    const csv = 'name,phone\n"Alice,+15551234567';
    expect(() => parseCsv(csv)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.CSV_MALFORMED }),
    );
  });

  it('rejects quotes inside unquoted fields with 400 CSV_MALFORMED', () => {
    const csv1 = 'firstName,lastName,phone\nAli"ce,Smith,+15551234567';
    expect(() => parseCsv(csv1)).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.CSV_MALFORMED,
        message: expect.stringContaining('quote found inside unquoted field'),
      }),
    );

    const csv2 = 'col1,col2\nval1,val"2';
    expect(() => parseCsv(csv2)).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.CSV_MALFORMED,
        message: expect.stringContaining('quote found inside unquoted field'),
      }),
    );
  });

  it('rejects characters following a closing quote with 400 CSV_MALFORMED', () => {
    const csv1 = 'firstName,lastName,phone\n"Alice"Smith,Smith,+15551234567';
    expect(() => parseCsv(csv1)).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.CSV_MALFORMED,
        message: expect.stringContaining('unexpected character'),
      }),
    );

    const csv2 = 'firstName,lastName,phone\n"Alice" ,Smith,+15551234567';
    expect(() => parseCsv(csv2)).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.CSV_MALFORMED,
        message: expect.stringContaining('unexpected character'),
      }),
    );
  });

  it('serializes rows according to RFC 4180', () => {
    expect(serializeCsvRow(['Alice', 'Smith', '+15551234567'])).toBe('Alice,Smith,+15551234567');
    expect(serializeCsvRow(['Bob', 'Hello, World', null])).toBe('Bob,"Hello, World",');
    expect(serializeCsvRow(['Charlie', 'He said "hi"', true])).toBe(
      'Charlie,"He said ""hi""",true',
    );
    expect(serializeCsvRow(['Multi', 'Line 1\nLine 2', 42])).toBe('Multi,"Line 1\nLine 2",42');
    expect(serializeCsvRow(['1', '{"badge":"2317","notes":"urgent, critical"}'])).toBe(
      '1,"{""badge"":""2317"",""notes"":""urgent, critical""}"',
    );
  });

  it('correctly round-trips complex JSON customFields via RFC 4180 escaping and parsing', () => {
    const originalJson = JSON.stringify({
      badge: '2317',
      formula: "'=cmd|' /C calc'!A0",
      notes: 'Contains "quotes" and, commas',
    });
    const serialized = serializeCsvRow(['contact-id', originalJson]);
    expect(serialized).toContain('"{""badge"":""2317""');
    const parsed = parseCsv(serialized);
    expect(parsed).toEqual([['contact-id', originalJson]]);
    expect(JSON.parse(parsed[0]![1]!)).toEqual({
      badge: '2317',
      formula: "'=cmd|' /C calc'!A0",
      notes: 'Contains "quotes" and, commas',
    });
  });

  it('parses CSV into structured objects', () => {
    const csv = 'firstName,lastName,phone\nAlice,Smith,+15551234567\nBob,Jones,+15559876543';
    const result = parseCsvToObjects(csv);
    expect(result.headers).toEqual(['firstName', 'lastName', 'phone']);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual({
      rowNumber: 2,
      data: {
        firstName: 'Alice',
        lastName: 'Smith',
        phone: '+15551234567',
      },
    });
    expect(result.records[1]).toEqual({
      rowNumber: 3,
      data: {
        firstName: 'Bob',
        lastName: 'Jones',
        phone: '+15559876543',
      },
    });
  });
});

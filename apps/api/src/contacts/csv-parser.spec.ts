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

  it('serializes rows according to RFC 4180', () => {
    expect(serializeCsvRow(['Alice', 'Smith', '+15551234567'])).toBe('Alice,Smith,+15551234567');
    expect(serializeCsvRow(['Bob', 'Hello, World', null])).toBe('Bob,"Hello, World",');
    expect(serializeCsvRow(['Charlie', 'He said "hi"', true])).toBe(
      'Charlie,"He said ""hi""",true',
    );
    expect(serializeCsvRow(['Multi', 'Line 1\nLine 2', 42])).toBe('Multi,"Line 1\nLine 2",42');
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

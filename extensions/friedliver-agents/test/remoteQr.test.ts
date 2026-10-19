import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { qrMatrix, qrSvg } from '../src/remote/qr';

describe('the pairing QR code', () => {
  it('matches the matrix an independent decoder (jsQR 1.4.0) read back', () => {
    // 76 strings of 1–213 bytes, versions 1–10, decoded by jsQR when this encoder was written; this one stands for them.
    const m = qrMatrix('https://192.168.1.23:54321/#c=AAAAAAAAAAAAAAAAAAAAAA&f=BBBB');
    expect(createHash('sha256').update(JSON.stringify(m)).digest('hex')).toBe('02997b79625bfe6b963276d168cab1a0819b6b9bd4cc677ee08294fa3c1d6938');
  });

  it('grows with the text and has finder patterns in three corners', () => {
    expect(qrMatrix('a')).toHaveLength(21);
    expect(qrMatrix('x'.repeat(100))).toHaveLength(41);
    const m = qrMatrix('x'.repeat(213));
    expect(m).toHaveLength(57);
    const n = m.length;
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      expect(m[y].slice(x, x + 7).every(Boolean)).toBe(true);
      expect(m[y + 1].slice(x + 1, x + 6).some(Boolean)).toBe(false);
    }
    expect(() => qrMatrix('x'.repeat(214))).toThrow();
  });

  it('draws dark on white, with no text of the link in the SVG', () => {
    const link = 'https://192.168.1.23:54321/#c=secret';
    const svg = qrSvg(link);
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 37 37"/);
    expect(svg).toContain('fill="#fff"');
    expect(svg).not.toContain('secret');
  });
});

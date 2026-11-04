import { describe, expect, it } from 'vitest';
import { pgConfig } from '../src/runner/db';

describe('connection settings', () => {
  const remote = 'postgres://u:secret@db.example.com:5432/postgres';

  it('refuses to send a password to a remote host without TLS, and does not repeat the URL', () => {
    for (const url of [remote, `${remote}?sslmode=disable`]) {
      expect(() => pgConfig(url, '')).toThrow(/TLS_REQUIRED/);
      try { pgConfig(url, ''); } catch (err) { expect(String(err)).not.toContain('secret'); }
    }
  });

  it('a CA replaces any sslmode, so the CA is what gets verified', () => {
    const config = pgConfig(`${remote}?sslmode=require`, 'CA-PEM');
    expect(config.ssl).toEqual({ ca: 'CA-PEM' });
    expect(config.connectionString).not.toContain('sslmode');
  });

  it('keeps an explicit sslmode, and allows a local database without TLS', () => {
    expect(pgConfig(`${remote}?sslmode=verify-full`, '').connectionString).toContain('sslmode=verify-full');
    expect(pgConfig('postgres://postgres@127.0.0.1:5432/postgres', '').ssl).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  apiBaseUrlErrorMessage,
  assertValidApiBaseUrl,
  isValidApiBaseUrl,
} from '../../scripts/api-base-url-guard';

describe('isValidApiBaseUrl', () => {
  it('allows unset / empty (offline-only build mode)', () => {
    expect(isValidApiBaseUrl(undefined)).toBe(true);
    expect(isValidApiBaseUrl(null)).toBe(true);
    expect(isValidApiBaseUrl('')).toBe(true);
    expect(isValidApiBaseUrl('   ')).toBe(true);
  });

  it('allows "/", root-relative paths, and absolute http(s) origins', () => {
    expect(isValidApiBaseUrl('/')).toBe(true);
    expect(isValidApiBaseUrl('/api')).toBe(true);
    expect(isValidApiBaseUrl('/api/')).toBe(true);
    expect(isValidApiBaseUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isValidApiBaseUrl('https://api.example.com')).toBe(true);
    expect(isValidApiBaseUrl('  https://api.example.com  ')).toBe(true);
  });

  it('rejects the MSYS-mangled Windows path (the incident signature)', () => {
    expect(isValidApiBaseUrl('C:/Program Files/Git')).toBe(false);
    expect(isValidApiBaseUrl('C:/Program Files/Git/')).toBe(false);
    expect(isValidApiBaseUrl('C:\\Program Files\\Git')).toBe(false);
  });

  it('rejects other malformed bases', () => {
    expect(isValidApiBaseUrl('//protocol-relative')).toBe(false);
    expect(isValidApiBaseUrl('file:///C:/Program Files/Git')).toBe(false);
    expect(isValidApiBaseUrl('ftp://host')).toBe(false);
    expect(isValidApiBaseUrl('example.com')).toBe(false);
    expect(isValidApiBaseUrl('api')).toBe(false);
  });
});

describe('assertValidApiBaseUrl', () => {
  it('does not throw for valid or unset values', () => {
    expect(() => assertValidApiBaseUrl(undefined)).not.toThrow();
    expect(() => assertValidApiBaseUrl('/')).not.toThrow();
    expect(() => assertValidApiBaseUrl('https://api.example.com')).not.toThrow();
  });

  it('throws an actionable message for the mangled path', () => {
    expect(() => assertValidApiBaseUrl('C:/Program Files/Git')).toThrow(
      /PUBLIC_KARAOKE_API_BASE_URL/,
    );
    const message = apiBaseUrlErrorMessage('C:/Program Files/Git');
    expect(message).toContain('MSYS');
    expect(message).toContain('MSYS2_ENV_CONV_EXCL');
    expect(message).toContain('PowerShell');
  });
});

import { describe, expect, it } from 'vitest';
import { EnvironmentValidationError, parseEnvironment } from '../src/config';

const valid = {
  DATABASE_URL: 'postgresql://app:private@localhost:5432/livestar',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('environment validation', () => {
  it('requires actual PostgreSQL and Redis URLs without leaking values', () => {
    expect(() => parseEnvironment({})).toThrow('DATABASE_URL, REDIS_URL');
    try {
      parseEnvironment({ ...valid, DATABASE_URL: 'https://secret-password@example.com' });
      throw new Error('expected validation rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).not.toContain('secret-password');
    }
  });

  it('rejects wildcard CORS origins, paths and invalid ports', () => {
    for (const WEB_ORIGIN of ['*', 'https://example.com/path', 'https://user:pass@example.com', '']) {
      expect(() => parseEnvironment({ ...valid, WEB_ORIGIN })).toThrow('WEB_ORIGIN');
    }
    for (const PORT of ['0', '65536', '40.5', '4e3', '']) {
      expect(() => parseEnvironment({ ...valid, PORT })).toThrow('PORT');
    }
  });

  it('supports explicit origins and safe defaults', () => {
    const config = parseEnvironment({ ...valid, WEB_ORIGIN: 'https://livestar.example,http://localhost:3000' });
    expect(config.webOrigins).toEqual(['https://livestar.example', 'http://localhost:3000']);
    expect(config.port).toBe(4000);
    expect(config.environment).toBe('development');
    expect(config.apiDocsEnabled).toBe(true);
  });
});

const production = {
  ...valid,
  NODE_ENV: 'production',
  JWT_SECRET: '79b856ea5e3ad409ec860de99e874c601f5260c5342bab7e7ec0912d2ca30ce8',
  WEB_ORIGIN: 'https://stream.livestar.tv',
  APP_PUBLIC_URL: 'https://stream.livestar.tv',
  SMTP_HOST: 'smtp.mailprovider.com',
  SMTP_PORT: '587',
  SMTP_FROM: 'noreply@stream.livestar.tv',
};

describe('public deployment configuration', () => {
  it('accepts a complete public HTTPS deployment while retaining private service URLs', () => {
    const config = parseEnvironment(production);
    expect(config.environment).toBe('production');
    expect(config.apiDocsEnabled).toBe(false);
    expect(config.databaseUrl).toBe(valid.DATABASE_URL);
    expect(config.redisUrl).toBe(valid.REDIS_URL);
    expect(parseEnvironment({ ...production, SMTP_HOST: 'smtp-relay.internal' }).smtpHost).toBe('smtp-relay.internal');
  });

  it('rejects shipped JWT examples and trivial secrets without printing their values', () => {
    for (const JWT_SECRET of [
      'livestar_local_development_key_replace_before_production_2026',
      'livestar_isolated_test_signing_key_not_for_production_2026',
      'livestar_ci_test_signing_key_not_for_production_2026',
      'replace_this_with_a_random_secret_value',
      'x'.repeat(64),
    ]) {
      try {
        parseEnvironment({ ...production, JWT_SECRET });
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvironmentValidationError);
        expect((error as Error).message).toContain('JWT_SECRET');
        expect((error as Error).message).not.toContain(JWT_SECRET);
      }
    }
  });

  it('rejects non-public browser origins and insecure or non-origin email-link URLs', () => {
    for (const WEB_ORIGIN of [
      'http://stream.livestar.tv', 'https://localhost', 'https://127.0.0.1', 'https://127.1',
      'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://192.168.0.5', 'https://10.1.2.3',
      'https://172.20.0.2', 'https://live.example.com', 'https://live.internal', 'https://live..com',
      'https://stream.livestar.tv,http://localhost:3000',
    ]) expect(() => parseEnvironment({ ...production, WEB_ORIGIN })).toThrow('WEB_ORIGIN');
    for (const APP_PUBLIC_URL of [
      'http://stream.livestar.tv', 'https://localhost', 'https://stream.livestar.tv/prefix',
      'https://stream.livestar.tv?token=hidden', 'https://stream.livestar.tv#fragment',
    ]) expect(() => parseEnvironment({ ...production, APP_PUBLIC_URL })).toThrow('APP_PUBLIC_URL');
  });

  it('requires an explicit mail service and a real sender domain for production recovery', () => {
    for (const SMTP_HOST of ['', 'localhost', '127.0.0.1', '[::1]', 'mailpit', 'mailhog', 'smtp.example.com']) {
      expect(() => parseEnvironment({ ...production, SMTP_HOST })).toThrow('SMTP_HOST');
    }
    for (const SMTP_FROM of ['noreply@livestar.local', 'noreply@localhost', 'noreply@integration.invalid']) {
      expect(() => parseEnvironment({ ...production, SMTP_FROM })).toThrow('SMTP_FROM');
    }
  });

  it('requires an explicit boolean to expose API documentation in production', () => {
    expect(parseEnvironment({ ...production, API_DOCS_ENABLED: 'true' }).apiDocsEnabled).toBe(true);
    expect(() => parseEnvironment({ ...production, API_DOCS_ENABLED: 'yes' })).toThrow('API_DOCS_ENABLED');
    expect(parseEnvironment({ ...valid, NODE_ENV: 'test' }).apiDocsEnabled).toBe(true);
  });

  it('allows explicit free-beta Redis and email opt-outs without weakening HTTPS or secrets', () => {
    const { REDIS_URL: _redis, SMTP_HOST: _smtpHost, SMTP_PORT: _smtpPort, SMTP_FROM: _smtpFrom, ...withoutServices } = production;
    const free = { ...withoutServices, REDIS_OPTIONAL: 'true', EMAIL_ENABLED: 'false', AUTH_HASH_CONCURRENCY: '1' };
    const config = parseEnvironment(free);
    expect(config.redisUrl).toBeUndefined();
    expect(config.redisOptional).toBe(true);
    expect(config.emailEnabled).toBe(false);
    expect(config.authHashConcurrency).toBe(1);
    expect(config.apiDocsEnabled).toBe(false);
    expect(() => parseEnvironment({ ...free, WEB_ORIGIN: 'http://localhost:3000' })).toThrow('WEB_ORIGIN');
    expect(() => parseEnvironment({ ...free, JWT_SECRET: 'livestar_local_development_key_replace_before_production_2026' })).toThrow('JWT_SECRET');
  });

  it('keeps services enabled by default and rejects ambiguous free-beta flags', () => {
    const config = parseEnvironment(valid);
    expect(config.redisOptional).toBe(false);
    expect(config.emailEnabled).toBe(true);
    expect(config.authHashConcurrency).toBe(2);
    for (const REDIS_OPTIONAL of ['yes', '1', '']) expect(() => parseEnvironment({ ...valid, REDIS_OPTIONAL })).toThrow('REDIS_OPTIONAL');
    for (const EMAIL_ENABLED of ['no', '0', '']) expect(() => parseEnvironment({ ...valid, EMAIL_ENABLED })).toThrow('EMAIL_ENABLED');
    for (const AUTH_HASH_CONCURRENCY of ['0', '3', '1.5', '']) expect(() => parseEnvironment({ ...valid, AUTH_HASH_CONCURRENCY })).toThrow('AUTH_HASH_CONCURRENCY');
    expect(() => parseEnvironment({ DATABASE_URL: valid.DATABASE_URL, REDIS_OPTIONAL: 'false' })).toThrow('REDIS_URL');
    expect(() => parseEnvironment({ ...valid, REDIS_OPTIONAL: 'true', REDIS_URL: 'https://not-a-redis-service' })).toThrow('REDIS_URL');
  });
});

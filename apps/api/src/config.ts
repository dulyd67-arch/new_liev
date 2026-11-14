import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  readonly databaseUrl: string;
  readonly redisUrl?: string;
  readonly redisOptional: boolean;
  readonly port: number;
  readonly host: string;
  readonly environment: 'development' | 'test' | 'production';
  readonly webOrigins: readonly string[];
  readonly jwtSecret: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly appPublicUrl: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpFrom: string;
  readonly smtpUser?: string;
  readonly smtpPassword?: string;
  readonly emailEnabled: boolean;
  readonly authHashConcurrency: number;
  readonly apiDocsEnabled: boolean;
}

export class EnvironmentValidationError extends Error {
  constructor(keys: string[]) {
    super(`Invalid or missing environment variables: ${keys.join(', ')}`);
    this.name = 'EnvironmentValidationError';
  }
}

/** Reject local/reserved destinations for browser-facing production origins. */
export function isPublicHostname(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const kind = isIP(host);
  if (kind === 4) {
    const [first, second, third] = host.split('.').map(Number);
    return !(first === 0 || first === 10 || first === 127 || first! >= 224
      || (first === 100 && second! >= 64 && second! <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second! >= 16 && second! <= 31)
      || (first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2))))
      || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
      || (first === 203 && second === 0 && third === 113));
  }
  if (kind === 6) return /^[23][0-9a-f]{3}:/.test(host) && !host.startsWith('2001:db8:');
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return false;
  if (host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  const reserved = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'example.com', 'example.net', 'example.org'];
  return !reserved.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

/** This detects shipped examples; operators must still generate random secrets. */
export function isUnsafeProductionSecret(value: string): boolean {
  return Buffer.byteLength(value) < 32 || /^(.)\1+$/.test(value)
    || /change[_ -]?(?:me|before|this)|replace[_ -]?(?:me|before|with|this)|not[_ -]?for[_ -]?production|livestar[_ -](?:local|isolated|ci|test)|(?:^|[_ -])(?:dev|test|example|sample|placeholder)(?:[_ -]|$)/i.test(value);
}

export function parseAuthHashConcurrency(value: string | undefined): number {
  if (value !== undefined && value !== '1' && value !== '2') {
    throw new EnvironmentValidationError(['AUTH_HASH_CONCURRENCY']);
  }
  return Number(value ?? '2');
}

/** Validation messages contain key names only, never URLs or secrets. */
export function parseEnvironment(env: NodeJS.ProcessEnv): AppConfig {
  const invalid = new Set<string>();
  const validUrl = (key: string, protocols: readonly string[]): string => {
    const raw = env[key]?.trim() ?? '';
    try {
      const parsed = new URL(raw);
      if (!protocols.includes(parsed.protocol) || !parsed.hostname) invalid.add(key);
    } catch {
      invalid.add(key);
    }
    return raw;
  };
  const databaseUrl = validUrl('DATABASE_URL', ['postgres:', 'postgresql:']);
  const rawRedisOptional = env.REDIS_OPTIONAL ?? 'false';
  if (!['true', 'false'].includes(rawRedisOptional)) invalid.add('REDIS_OPTIONAL');
  const redisOptional = rawRedisOptional === 'true';
  const redisUrl = redisOptional && !env.REDIS_URL?.trim()
    ? undefined : validUrl('REDIS_URL', ['redis:', 'rediss:']);
  const rawEmailEnabled = env.EMAIL_ENABLED ?? 'true';
  if (!['true', 'false'].includes(rawEmailEnabled)) invalid.add('EMAIL_ENABLED');
  const emailEnabled = rawEmailEnabled !== 'false';
  let authHashConcurrency = 2;
  try { authHashConcurrency = parseAuthHashConcurrency(env.AUTH_HASH_CONCURRENCY); }
  catch { invalid.add('AUTH_HASH_CONCURRENCY'); }
  const environment = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) invalid.add('NODE_ENV');
  const rawPort = env.PORT ?? '4000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    invalid.add('PORT');
  }
  const webOrigins = (env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((value) => value.trim());
  for (const origin of webOrigins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password
        || (environment === 'production' && (url.protocol !== 'https:' || !isPublicHostname(url.hostname)))) {
        invalid.add('WEB_ORIGIN');
      }
    } catch {
      invalid.add('WEB_ORIGIN');
    }
  }
  const host = env.API_HOST?.trim() || '0.0.0.0';
  const jwtSecret = env.JWT_SECRET ?? (environment === 'production' ? '' : randomBytes(32).toString('base64url'));
  if (Buffer.byteLength(jwtSecret) < 32 || (environment === 'production' && isUnsafeProductionSecret(jwtSecret))) invalid.add('JWT_SECRET');
  const jwtIssuer = env.JWT_ISSUER?.trim() || 'livestar';
  const jwtAudience = env.JWT_AUDIENCE?.trim() || 'livestar-clients';
  const appPublicUrl = env.APP_PUBLIC_URL ?? 'http://localhost:3000';
  try {
    const parsed = new URL(appPublicUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || (environment === 'production' && (parsed.protocol !== 'https:' || !isPublicHostname(parsed.hostname)
        || !!parsed.search || !!parsed.hash || parsed.pathname !== '/'))) invalid.add('APP_PUBLIC_URL');
  } catch { invalid.add('APP_PUBLIC_URL'); }
  const smtpHost = env.SMTP_HOST?.trim() || '127.0.0.1';
  const smtpPort = Number(env.SMTP_PORT ?? '1025');
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) invalid.add('SMTP_PORT');
  if (environment === 'production' && emailEnabled) {
    const localMail = smtpHost.toLowerCase().replace(/^\[|\]$/g, '');
    if (!env.SMTP_HOST?.trim() || /^(?:localhost|mailpit|mailhog|::1)$/.test(localMail)
      || /^127\./.test(localMail) || /\.(?:localhost|local|invalid|test|example)$/.test(localMail)
      || /(?:^|\.)example\.(?:com|net|org)$/.test(localMail)
      || (!isIP(localMail) && !/^[a-zA-Z0-9_.-]+$/.test(smtpHost))) invalid.add('SMTP_HOST');
  }
  const smtpFrom = env.SMTP_FROM ?? 'noreply@livestar.local';
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(smtpFrom)) invalid.add('SMTP_FROM');
  if (environment === 'production' && emailEnabled && !isPublicHostname(smtpFrom.split('@')[1] ?? '')) invalid.add('SMTP_FROM');
  if (!!env.SMTP_USER !== !!env.SMTP_PASSWORD) invalid.add('SMTP_USER/SMTP_PASSWORD');
  const rawApiDocs = env.API_DOCS_ENABLED ?? (environment === 'production' ? 'false' : 'true');
  if (!['true', 'false'].includes(rawApiDocs)) invalid.add('API_DOCS_ENABLED');
  if (invalid.size) throw new EnvironmentValidationError([...invalid]);
  return Object.freeze({
    databaseUrl,
    redisUrl,
    redisOptional,
    port,
    host,
    environment: environment as AppConfig['environment'],
    webOrigins: Object.freeze([...new Set(webOrigins)]),
    jwtSecret,
    jwtIssuer,
    jwtAudience,
    appPublicUrl,
    smtpHost,
    smtpPort,
    smtpFrom,
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_PASSWORD,
    emailEnabled,
    authHashConcurrency,
    apiDocsEnabled: rawApiDocs === 'true',
  });
}

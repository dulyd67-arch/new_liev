import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/application';
import { APP_CONFIG, parseEnvironment } from '../src/config';
import { DatabaseService } from '../src/database.service';
import { RedisService } from '../src/redis.service';
import { LiveKitService } from '../src/streams/livekit.service';

describe('production API documentation visibility', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  async function application(exposeDocs?: string) {
    const config = parseEnvironment({
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://app:fixture@postgres:5432/livestar',
      REDIS_URL: 'redis://redis:6379', WEB_ORIGIN: 'https://stream.livestar.tv',
      APP_PUBLIC_URL: 'https://stream.livestar.tv',
      JWT_SECRET: '1fd60b15ebc02771ba7abfc09dc6c378e58c2560354aa47b6139f76e35f1b1cef',
      SMTP_HOST: 'smtp.mailprovider.com', SMTP_FROM: 'noreply@stream.livestar.tv',
      ...(exposeDocs !== undefined ? { API_DOCS_ENABLED: exposeDocs } : {}),
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG).useValue(config)
      .overrideProvider(DatabaseService).useValue({ probe: async () => undefined })
      .overrideProvider(RedisService).useValue({ probe: async () => undefined })
      .overrideProvider(LiveKitService).useValue({ configured: () => true })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApplication(app);
    await app.init();
    return app;
  }

  it('keeps normal health routes but omits Swagger UI and raw OpenAPI by default', async () => {
    const server = await application();
    await request(server.getHttpServer()).get('/api/v1/health/live').expect(200);
    await request(server.getHttpServer()).get('/api/docs').expect(404);
    await request(server.getHttpServer()).get('/api/openapi.json').expect(404);
    await request(server.getHttpServer()).get('/api/docs/swagger-ui-init.js').expect(404);
  });

  it('exposes documentation only after an explicit operator opt-in', async () => {
    const server = await application('true');
    const result = await request(server.getHttpServer()).get('/api/openapi.json').expect(200);
    expect(result.body.info.version).toBe('0.4.0');
    expect(result.body.paths['/api/v1/streams']).toBeDefined();
    await request(server.getHttpServer()).get('/api/docs').expect(200);
  });
});

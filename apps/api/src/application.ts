import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config';

export function configureApplication(app: INestApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.use(helmet());
  app.enableCors({
    origin: [...config.webOrigins],
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  // Amounts remain exact when future APIs serialize database BIGINT values.
  app.getHttpAdapter().getInstance().set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value);
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  if (config.apiDocsEnabled) {
    const definition = new DocumentBuilder()
      .setTitle('LiveStar API')
      .setDescription('LiveStar accounts, live video, and chat API.')
      .setVersion('0.4.0')
      .addBearerAuth()
      .addCookieAuth('livestar_refresh')
      .addTag('Health')
      .addTag('Platform')
      .build();
    const document = SwaggerModule.createDocument(app, definition);
    SwaggerModule.setup('api/docs', app, document, {
      jsonDocumentUrl: '/api/openapi.json',
      swaggerOptions: { supportedSubmitMethods: [] },
    });
  }
  app.enableShutdownHooks();
}

export async function createApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
    abortOnError: false,
  });
  configureApplication(app);
  return app;
}

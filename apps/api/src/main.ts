import 'reflect-metadata';
import { config as loadEnvironment } from 'dotenv';
import { createApplication } from './application';
import { APP_CONFIG, AppConfig, EnvironmentValidationError } from './config';

loadEnvironment({ path: ['../../.env', '.env'], quiet: true });

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port, config.host);
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof EnvironmentValidationError ? error.message : 'LiveStar API startup failed.');
  process.exitCode = 1;
});

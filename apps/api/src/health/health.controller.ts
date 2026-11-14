import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DEPENDENCY_PROBE, DependencyProbe, DependencyStatus } from './health.service';

class DependencyStatusDto implements DependencyStatus {
  @ApiProperty({ type: String, enum: ['up', 'down'] }) postgres!: 'up' | 'down';
  @ApiProperty({ type: String, enum: ['up', 'down', 'disabled'] }) redis!: 'up' | 'down' | 'disabled';
}

class LiveHealthDto {
  @ApiProperty({ type: String, enum: ['ok'] }) status!: 'ok';
  @ApiProperty({ type: String, example: 'livestar-api' }) service!: string;
}

class ReadyHealthDto {
  @ApiProperty({ type: String, enum: ['ready', 'not_ready'] }) status!: 'ready' | 'not_ready';
  @ApiProperty({ type: DependencyStatusDto }) dependencies!: DependencyStatusDto;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@Inject(DEPENDENCY_PROBE) private readonly dependencies: DependencyProbe) {}

  @Get('live')
  @SkipThrottle()
  @ApiOkResponse({ type: LiveHealthDto, description: 'Process is serving HTTP; no dependency probe.' })
  live(): LiveHealthDto {
    return { status: 'ok', service: 'livestar-api' };
  }

  @Get('ready')
  @ApiOkResponse({ type: ReadyHealthDto, description: 'PostgreSQL is reachable; Redis is reachable or explicitly disabled.' })
  @ApiServiceUnavailableResponse({ type: ReadyHealthDto, description: 'At least one dependency is unavailable.' })
  async ready(): Promise<ReadyHealthDto> {
    const dependencies = await this.dependencies.check();
    const status = dependencies.postgres === 'up' && ['up', 'disabled'].includes(dependencies.redis) ? 'ready' : 'not_ready';
    const result: ReadyHealthDto = { status, dependencies };
    if (status === 'not_ready') throw new ServiceUnavailableException(result);
    return result;
  }
}

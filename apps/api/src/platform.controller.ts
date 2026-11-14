import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, AppConfig } from './config';

class PlatformStatusDto {
  @ApiProperty({ type: String, example: 'LiveStar' }) name!: string;
  @ApiProperty({ type: String, example: '0.4.0' }) version!: string;
  @ApiProperty({ type: String, example: 'live-only' }) mode!: string;
  @ApiProperty({ type: [String], example: ['ar', 'en'] }) languages!: string[];
  @ApiProperty({ type: Boolean }) streamingEnabled!: boolean;
  @ApiProperty({ type: Boolean }) emailEnabled!: boolean;
}

@ApiTags('Platform')
@Controller('platform')
export class PlatformController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  @Get()
  @ApiOkResponse({ type: PlatformStatusDto, description: 'LiveStar live-only web platform and media configuration availability.' })
  getStatus(): PlatformStatusDto {
    return {
      name: 'LiveStar', version: '0.4.0', mode: 'live-only', languages: ['ar', 'en'],
      streamingEnabled: !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET),
      emailEnabled: this.config.emailEnabled,
    };
  }
}

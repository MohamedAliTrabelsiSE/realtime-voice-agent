import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, type AppConfig } from './config/app-config';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  health(): { status: 'ok'; realtimeMode: 'mock' | 'openai'; model: string; business: string } {
    return {
      status: 'ok',
      realtimeMode: this.config.realtime.mock ? 'mock' : 'openai',
      model: this.config.realtime.model,
      business: this.config.business.name,
    };
  }
}

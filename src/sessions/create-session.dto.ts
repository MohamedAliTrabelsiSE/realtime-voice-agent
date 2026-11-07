import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSessionDto {
  @ApiPropertyOptional({
    example: 'Jane Doe',
    description: 'Optional caller name given to the agent',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  callerName?: string;
}

export class CreateSessionResponseDto {
  @ApiProperty() sessionId!: string;
  @ApiProperty({ example: 'ws://localhost:3000/voice/stream' }) wsUrl!: string;
  @ApiProperty({ description: 'Send in the WebSocket "start" event' }) voiceToken!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ enum: ['mock', 'openai'] }) realtimeMode!: 'mock' | 'openai';
}

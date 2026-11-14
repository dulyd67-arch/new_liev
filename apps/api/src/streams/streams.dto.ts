import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const STREAM_CATEGORIES = ['chat', 'music', 'gaming', 'talent'] as const;

export class CreateStreamDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 160 })
  @IsString() @MinLength(1) @MaxLength(160) title!: string;

  @ApiPropertyOptional({ type: String, enum: STREAM_CATEGORIES })
  @IsOptional() @IsIn(STREAM_CATEGORIES) category?: typeof STREAM_CATEGORIES[number];
}

export class StreamQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) query?: string;
  @ApiPropertyOptional({ type: String, enum: STREAM_CATEGORIES }) @IsOptional() @IsIn(STREAM_CATEGORIES) category?: typeof STREAM_CATEGORIES[number];
}

export class MessageDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 500 })
  @IsString() @MinLength(1) @MaxLength(500) body!: string;
}

export class MessageQueryDto {
  @ApiPropertyOptional({ type: String, description: 'ISO timestamp of the last received message.' })
  @IsOptional() @IsString() @MaxLength(40)
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
  after?: string;
}

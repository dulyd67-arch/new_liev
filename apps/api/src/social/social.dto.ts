import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class FollowStatusDto {
  @ApiProperty({ type: Boolean }) following!: boolean;
}

export class ReportStreamDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 500, description: 'Explain why this livestream should be reviewed.' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(500)
  reason!: string;
}

export class ReportReceiptDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, enum: ['OPEN'] }) status!: 'OPEN';
}

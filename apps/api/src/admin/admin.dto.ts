import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class AdminPageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional() @IsUUID() cursor?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 20, default: 20 })
  @IsOptional() @Transform(({ value }: { value: unknown }) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value)
  @IsInt() @Min(1) @Max(20) limit?: number;
}

export class AdminUsersQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 80 })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) query?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED'] })
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
}

export class AdminStreamsQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ enum: ['LIVE', 'SCHEDULED', 'TERMINATED', 'ENDED'] })
  @IsOptional() @IsIn(['LIVE', 'SCHEDULED', 'TERMINATED', 'ENDED']) status?: 'LIVE' | 'SCHEDULED' | 'TERMINATED' | 'ENDED';
}

export class AdminReportsQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'] })
  @IsOptional() @IsIn(['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED']) status?: 'OPEN' | 'REVIEWING' | 'RESOLVED' | 'DISMISSED';
}

export class AdminReasonDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 1000 })
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) reason!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID() idempotencyKey!: string;
}

export class AdminReviewReportDto extends AdminReasonDto {
  @ApiProperty({ enum: ['REVIEWING', 'RESOLVED', 'DISMISSED'] })
  @IsIn(['REVIEWING', 'RESOLVED', 'DISMISSED']) status!: 'REVIEWING' | 'RESOLVED' | 'DISMISSED';
}

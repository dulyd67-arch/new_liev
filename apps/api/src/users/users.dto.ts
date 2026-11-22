import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateBy, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_AVATAR_DATA_URL_LENGTH, parseProfileAvatar } from './avatar';

const trim = ({ value }: { value: unknown }): unknown => typeof value === 'string' ? value.trim() : value;

export class UpdateProfileDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 80 })
  @ValidateIf((_object, value: unknown) => value !== undefined) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80)
  displayName?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500)
  bio?: string | null;

  @ApiPropertyOptional({ type: String, enum: ['ar', 'en'] })
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsIn(['ar', 'en'])
  locale?: 'ar' | 'en';

  @ApiPropertyOptional({ type: String, example: 'Asia/Riyadh', maxLength: 64 })
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsString() @MaxLength(64)
  @ValidateBy({ name: 'ianaTimeZone', validator: { validate(value: unknown): boolean {
    if (typeof value !== 'string' || !value.length) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, defaultMessage: () => 'timezone must be a supported IANA time zone' } })
  timezone?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: MAX_AVATAR_DATA_URL_LENGTH, description: 'A small JPEG, PNG or WebP data URL. Null removes the photo.' })
  @IsOptional() @IsString() @MaxLength(MAX_AVATAR_DATA_URL_LENGTH)
  @ValidateBy({ name: 'profileAvatar', validator: { validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try { parseProfileAvatar(value); return true; } catch { return false; }
  }, defaultMessage: () => 'avatarDataUrl must contain a JPEG, PNG or WebP up to 48 KiB and 512 × 512 pixels' } })
  avatarDataUrl?: string | null;
}

export class ProfilePageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', description: 'Last returned ID for stable ascending pagination.' })
  @IsOptional() @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 20, default: 20 })
  @IsOptional() @Transform(({ value }: { value: unknown }) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value)
  @IsInt() @Min(1) @Max(20)
  limit?: number;
}

export class SearchUsersDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 80, example: 'star' })
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  query!: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 20, default: 20 })
  @IsOptional() @Transform(({ value }: { value: unknown }) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value)
  @IsInt() @Min(1) @Max(20)
  limit?: number;
}

export class DeleteAccountDto {
  @ApiProperty({ type: String, format: 'password', maxLength: 1024 })
  @IsString() @MinLength(1) @MaxLength(1024)
  password!: string;
}

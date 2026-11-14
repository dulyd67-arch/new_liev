import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsDateString, IsEmail, IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'creator@example.com' })
  @IsEmail() @MaxLength(320) email!: string;
  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
}

export class RegisterDto extends LoginDto {
  @ApiProperty({ example: 'live_creator' })
  @IsString() @Matches(/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/) username!: string;
  @ApiProperty({ example: 'Live Creator' })
  @IsString() @MinLength(1) @MaxLength(80) displayName!: string;
  @ApiProperty({ example: '1995-06-15', description: 'Self-declared date of birth; not external identity verification.' })
  @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) birthDate!: string;
  @ApiProperty({ enum: ['ar', 'en'] }) @IsIn(['ar', 'en']) locale!: 'ar' | 'en';
  @ApiProperty({ example: '2026-11-07' }) @IsString() @MinLength(1) @MaxLength(80) termsVersion!: string;
  @ApiProperty({ example: '2026-11-07' }) @IsString() @MinLength(1) @MaxLength(80) privacyVersion!: string;
  @ApiProperty({ example: true }) @Equals(true) acceptTerms!: boolean;
  @ApiProperty({ example: true }) @Equals(true) acceptPrivacy!: boolean;
}

export class RefreshDto {
  @ApiProperty({ description: 'Opaque mobile refresh token. Web uses an HttpOnly cookie.' })
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) refreshToken!: string;
}

export class EmailDto {
  @ApiProperty({ example: 'creator@example.com' }) @IsEmail() @MaxLength(320) email!: string;
}

export class ChallengeDto {
  @ApiProperty({ description: 'One-use token delivered by email.' })
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
}

export class ResetPasswordDto extends ChallengeDto {
  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
}

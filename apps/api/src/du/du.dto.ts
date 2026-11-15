import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateBy } from 'class-validator';

const BIGINT_MAX = 9_223_372_036_854_775_807n;
const isSequence = (value: unknown): boolean => typeof value === 'string'
  && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BIGINT_MAX;

export class ClaimDuDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'A new UUID per intentional action. Reuse this UUID when retrying the same request.' })
  @IsUUID() idempotencyKey!: string;
}

export class SendDuGiftDto extends ClaimDuDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID() giftId!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 99 })
  @IsInt() @Min(1) @Max(99) quantity!: number;
}

export class DuHistoryQueryDto {
  @ApiPropertyOptional({ type: String, pattern: '^(0|[1-9][0-9]{0,18})$', description: 'Return entries before this exact sequence; omit for the newest page. At most 50 entries per page.' })
  @IsOptional() @IsString() @MaxLength(19) @Matches(/^(?:0|[1-9][0-9]{0,18})$/)
  @ValidateBy({ name: 'duHistorySequence', validator: { validate: isSequence, defaultMessage: () => 'cursor must be a nonnegative BIGINT sequence' } })
  cursor?: string;
}

export class DuFeedQueryDto {
  @ApiPropertyOptional({ type: String, pattern: '^(0|[1-9][0-9]{0,18})$', description: 'Return gift events after this exact sequence. Omit to establish the current cursor without replaying old gifts. At most 50 events per poll.' })
  @IsOptional() @IsString() @MaxLength(19) @Matches(/^(?:0|[1-9][0-9]{0,18})$/)
  @ValidateBy({ name: 'duFeedSequence', validator: { validate: isSequence, defaultMessage: () => 'after must be a nonnegative BIGINT sequence' } })
  after?: string;
}

export class DuWalletDto {
  @ApiProperty({ type: String, enum: ['DU'] }) currency!: 'DU';
  @ApiProperty({ type: String, example: '100', description: 'Exact promotional DU balance, serialized as an integer string.' }) balance!: string;
  @ApiProperty({ type: Boolean }) claimAvailable!: boolean;
  @ApiProperty({ type: String, example: '25' }) receivedCoins!: string;
  @ApiProperty({ type: String, example: '3' }) receivedGifts!: string;
  @ApiProperty({ type: Boolean, enum: [true], description: 'DU is promotional and has no cash value.' }) promotional!: true;
  @ApiProperty({ type: Boolean, enum: [false] }) purchasingEnabled!: false;
}

export class DuGiftDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) slug!: string;
  @ApiProperty({ type: String }) nameAr!: string;
  @ApiProperty({ type: String }) nameEn!: string;
  @ApiProperty({ type: String }) emoji!: string;
  @ApiProperty({ type: String, example: '5' }) price!: string;
  @ApiProperty({ type: String }) effect!: string;
}

export class DuCatalogDto {
  @ApiProperty({ type: [DuGiftDto] }) items!: DuGiftDto[];
  @ApiProperty({ type: String, enum: ['DU'] }) currency!: 'DU';
  @ApiProperty({ type: Boolean, enum: [true] }) promotional!: true;
}

export class DuTransactionDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, example: '123' }) sequence!: string;
  @ApiProperty({ type: String, enum: ['CLAIM', 'GIFT'] }) type!: 'CLAIM' | 'GIFT';
  @ApiProperty({ type: String, description: 'Signed exact DU movement: a claim is positive; sending a gift is negative.' }) amount!: string;
  @ApiProperty({ type: String }) balanceAfter!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) streamId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) quantity!: number | null;
  @ApiProperty({ type: DuGiftDto, nullable: true }) gift!: DuGiftDto | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class DuMutationDto {
  @ApiProperty({ type: DuTransactionDto }) transaction!: DuTransactionDto;
  @ApiProperty({ type: DuWalletDto }) wallet!: DuWalletDto;
}

export class DuHistoryDto {
  @ApiProperty({ type: [DuTransactionDto] }) items!: DuTransactionDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class DuGiftSenderDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) username!: string | null;
  @ApiProperty({ type: String }) displayName!: string;
}

export class DuGiftEventDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) sequence!: string;
  @ApiProperty({ type: Number }) quantity!: number;
  @ApiProperty({ type: String }) totalPrice!: string;
  @ApiProperty({ type: DuGiftDto }) gift!: DuGiftDto;
  @ApiProperty({ type: DuGiftSenderDto }) sender!: DuGiftSenderDto;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class DuGiftFeedDto {
  @ApiProperty({ type: [DuGiftEventDto] }) items!: DuGiftEventDto[];
  @ApiProperty({ type: String, description: 'Persist this exact value and pass it as after when polling.' }) nextCursor!: string;
  @ApiProperty({ type: String }) totalCoins!: string;
  @ApiProperty({ type: String }) totalGifts!: string;
}

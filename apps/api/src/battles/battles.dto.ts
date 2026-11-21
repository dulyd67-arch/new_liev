import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class InviteBattleDto {
  @ApiProperty({ type: String, format: 'uuid' }) @IsUUID() opponentStreamId!: string;
  @ApiProperty({ type: String, format: 'uuid', description: 'Reuse this UUID only when retrying the same invitation.' })
  @IsUUID() idempotencyKey!: string;
}

export class BattleActionDto {}

export class SendLikesDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 20 }) @IsInt() @Min(1) @Max(20) count!: number;
  @ApiProperty({ type: String, format: 'uuid', description: 'Reuse this UUID only when retrying the same batch of likes.' })
  @IsUUID() idempotencyKey!: string;
}

export class BattleParticipantDto {
  @ApiProperty({ type: String, format: 'uuid' }) streamId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String, nullable: true }) username!: string | null;
  @ApiProperty({ type: String }) displayName!: string;
}

export class BattleViewDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, enum: ['INVITED', 'ACTIVE', 'FINISHED', 'DECLINED', 'CANCELED'] })
  status!: 'INVITED' | 'ACTIVE' | 'FINISHED' | 'DECLINED' | 'CANCELED';
  @ApiProperty({ type: BattleParticipantDto }) host!: BattleParticipantDto;
  @ApiProperty({ type: BattleParticipantDto }) guest!: BattleParticipantDto;
  @ApiProperty({ type: String, format: 'uuid' }) inviterId!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startsAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) endsAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) invitationExpiresAt!: string;
  @ApiProperty({ type: Number, enum: [300] }) durationSeconds!: number;
  @ApiProperty({ type: String, description: 'Exact promotional DU gifted during this battle; likes do not add DU.' }) hostScore!: string;
  @ApiProperty({ type: String }) guestScore!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) winnerStreamId!: string | null;
  @ApiProperty({ type: String, nullable: true }) finishReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) settledAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) serverNow!: string;
}

export class BattleSnapshotDto {
  @ApiProperty({ type: BattleViewDto, nullable: true }) battle!: BattleViewDto | null;
  @ApiProperty({ type: String, format: 'date-time' }) serverNow!: string;
}

export class BattleInvitationsDto {
  @ApiProperty({ type: [BattleViewDto] }) items!: BattleViewDto[];
  @ApiProperty({ type: String, format: 'date-time' }) serverNow!: string;
}

export class LikeTotalDto {
  @ApiProperty({ type: String, description: 'Exact count of authenticated, accepted likes.' }) total!: string;
  @ApiProperty({ type: String, format: 'date-time' }) serverNow!: string;
}

export class LikeMutationDto extends LikeTotalDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 20, description: 'Original accepted batch size, including on an idempotent retry.' }) acceptedCount!: number;
}

export class BattleCandidateCreatorDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) username!: string | null;
  @ApiProperty({ type: String }) displayName!: string;
}

export class BattleCandidateDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String, nullable: true }) category!: string | null;
  @ApiProperty({ type: String, enum: ['LIVE'] }) status!: string;
  @ApiProperty({ type: BattleCandidateCreatorDto }) creator!: BattleCandidateCreatorDto;
  @ApiProperty({ type: Number, nullable: true }) viewerCount!: number | null;
  @ApiProperty({ type: Boolean }) mediaAvailable!: boolean;
  @ApiProperty({ type: Boolean }) publisherConnected!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) endedAt!: Date | null;
}

export class BattleCandidatesDto {
  @ApiProperty({ type: [BattleCandidateDto] }) items!: BattleCandidateDto[];
}

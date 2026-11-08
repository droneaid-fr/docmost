import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';

const trim = ({ value }: TransformFnParams) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAgentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  spaceName: string;

  // Same rule as core CreateSpaceDto.slug.
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
    message:
      'Space slug must start with a letter or number and may contain hyphens and underscores',
  })
  spaceSlug: string;
}

export class CreateAgentTokenDto {
  @IsUUID()
  agentUserId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}

export class RevokeAgentTokenDto {
  @IsUUID()
  tokenId: string;
}

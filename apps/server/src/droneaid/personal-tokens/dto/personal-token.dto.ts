import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';

const trim = ({ value }: TransformFnParams) =>
  typeof value === 'string' ? value.trim() : value;

export class CreatePersonalTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Transform(trim)
  name: string;

  /** Omitted: the token never expires (it can still be revoked). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}

export class RevokePersonalTokenDto {
  @IsUUID()
  tokenId: string;
}

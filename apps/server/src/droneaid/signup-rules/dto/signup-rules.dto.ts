import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SPACE_GRANT_ROLES, SpaceGrantRole } from '../signup-rules.matcher';

export class SignupRuleInputDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  // Pattern validity (empty, never-matching) is checked by the service, so the
  // admin gets one message naming the rule.
  @IsString()
  @MaxLength(320)
  pattern: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  spaceIds: string[];

  @IsIn(SPACE_GRANT_ROLES)
  spaceRole: SpaceGrantRole;
}

export class SaveSignupRulesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SignupRuleInputDto)
  rules: SignupRuleInputDto[];

  @IsBoolean()
  allowGoogleSignup: boolean;
}

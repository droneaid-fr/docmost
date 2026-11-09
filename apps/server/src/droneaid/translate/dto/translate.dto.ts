import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class TranslationPageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  pageId: string;
}

export class SetTranslationsDto extends TranslationPageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(8)
  sourceLang: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  languages: string[];
}

export class SharedTranslationDto extends TranslationPageDto {
  @IsOptional()
  @IsString()
  @MaxLength(8)
  lang?: string;
}

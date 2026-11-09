import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createGeminiClient, type GenerateText } from './gemini';
import { readTranslateConfig, TranslateConfig } from './translate.config';

/** Live translation config and the model client built from it. */
@Injectable()
export class TranslationProvider {
  constructor(private readonly configService: ConfigService) {}

  config(): TranslateConfig {
    return readTranslateConfig((key) => this.configService.get<string>(key));
  }

  get enabled(): boolean {
    return this.config().enabled;
  }

  /** Null while no API key is set. */
  generator(): GenerateText | null {
    const { apiKey, model, baseUrl } = this.config();
    return apiKey ? createGeminiClient({ apiKey, model, baseUrl }) : null;
  }
}

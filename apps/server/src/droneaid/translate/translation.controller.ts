import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { ShareService } from '../../core/share/share.service';
import {
  SetTranslationsDto,
  SharedTranslationDto,
  TranslationPageDto,
} from './dto/translate.dto';
import { TranslationAccess } from './translation.access';
import { TranslationService } from './translation.service';
import { TranslationRepo } from './translation.repo';
import { TranslationProvider } from './translation.provider';

/**
 *   POST /api/droneaid/translate/page          state for the share menu (page viewers)
 *   POST /api/droneaid/translate/page/set      choose source and target languages (sharers)
 *   POST /api/droneaid/translate/page/update   translate every language again (sharers)
 *   POST /api/droneaid/translate/shared        public: languages of a shared page, and
 *                                              one translation when `lang` is given
 */
@UseGuards(JwtAuthGuard)
@Controller('droneaid/translate')
export class TranslationController {
  constructor(
    private readonly access: TranslationAccess,
    private readonly service: TranslationService,
    private readonly repo: TranslationRepo,
    private readonly provider: TranslationProvider,
    private readonly shareService: ShareService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('page')
  async page(
    @Body() dto: TranslationPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.access.findPage(dto.pageId, workspace.id);
    await this.access.assertCanView(page, user);
    return this.service.view(page, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('page/set')
  async set(
    @Body() dto: SetTranslationsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.access.findPage(dto.pageId, workspace.id);
    this.assertEnabled();
    await this.access.assertCanManage(page, user);
    await this.service.setLanguages(page, dto.sourceLang, dto.languages);
    return this.service.view(page, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('page/update')
  async update(
    @Body() dto: TranslationPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.access.findPage(dto.pageId, workspace.id);
    this.assertEnabled();
    await this.access.assertCanManage(page, user);
    await this.service.update(page);
    return this.service.view(page, user);
  }

  /**
   * Same gate as core's POST /api/shares/page-info: the page must be
   * reachable through a share, sharing allowed, no restricted ancestor
   * (ShareService.getSharedPage). Attachments in the translation get the
   * same public tokens as the original (updatePublicAttachments).
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('shared')
  async shared(
    @Body() dto: SharedTranslationDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const { page, share } = await this.shareService.getSharedPage(
      { pageId: dto.pageId },
      workspace.id,
      { includeContent: false },
    );
    if (
      !(await this.shareService.isSharingAllowed(workspace.id, share.spaceId))
    ) {
      throw new NotFoundException('Shared page not found');
    }
    if (!this.provider.enabled) {
      return { sourceLang: null, languages: [], translation: null };
    }
    const served = await this.repo.servedLanguages(page.id);
    const languages = served.map((row) => row.lang);
    let translation = null;
    if (dto.lang && languages.includes(dto.lang)) {
      const row = await this.repo.getServed(page.id, dto.lang);
      if (row) {
        translation = {
          lang: dto.lang,
          title: row.title,
          content: await this.shareService.updatePublicAttachments({
            ...page,
            content: row.content,
          }),
        };
      }
    }
    return {
      sourceLang: served[0]?.sourceLang ?? null,
      languages,
      translation,
    };
  }

  private assertEnabled() {
    if (!this.provider.enabled) {
      throw new NotFoundException('Translation is disabled');
    }
  }
}

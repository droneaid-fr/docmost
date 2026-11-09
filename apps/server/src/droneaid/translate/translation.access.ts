import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { ShareService } from '../../core/share/share.service';

/**
 * Who may do what with translations. Translations belong to publishing, so
 * managing them takes what creating a share takes in core
 * (ShareController.create): edit rights on the page, public sharing allowed
 * in its space and workspace, and no restricted ancestor; plus the page must
 * actually be public (its own share, or a shared ancestor with sub-pages).
 */
@Injectable()
export class TranslationAccess {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageAccess: PageAccessService,
    private readonly shareService: ShareService,
  ) {}

  async findPage(pageId: string, workspaceId: string): Promise<Page> {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.deletedAt || page.workspaceId !== workspaceId) {
      throw new NotFoundException('Page not found');
    }
    return page;
  }

  /** The page is reachable through a share (sharing settings aside). */
  async hasShare(page: Pick<Page, 'id' | 'workspaceId'>): Promise<boolean> {
    return !!(await this.shareService.getShareForPage(
      page.id,
      page.workspaceId,
    ));
  }

  /** A public reader can open the page right now. */
  async isPublished(page: Page): Promise<boolean> {
    const share = await this.shareService.getShareForPage(
      page.id,
      page.workspaceId,
    );
    if (!share) return false;
    if (
      !(await this.shareService.isSharingAllowed(
        page.workspaceId,
        share.spaceId,
      ))
    ) {
      return false;
    }
    return !(await this.pagePermissionRepo.hasRestrictedAncestor(page.id));
  }

  /** Throws unless `user` may read the page in the app. */
  async assertCanView(page: Page, user: User): Promise<void> {
    await this.pageAccess.validateCanView(page, user);
  }

  /** True when `user` may share the page, hence manage its translations. */
  async canManage(page: Page, user: User): Promise<boolean> {
    try {
      await this.pageAccess.validateCanEdit(page, user);
    } catch {
      return false;
    }
    return this.shareService.isSharingAllowed(page.workspaceId, page.spaceId);
  }

  async assertCanManage(page: Page, user: User): Promise<void> {
    if (!(await this.canManage(page, user))) throw new ForbiddenException();
    if (!(await this.isPublished(page))) {
      throw new BadRequestException('The page is not shared to the web.');
    }
  }
}

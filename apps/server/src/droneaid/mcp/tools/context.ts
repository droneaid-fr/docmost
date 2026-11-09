import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueName } from '../../../integrations/queue/constants';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { Page, Space } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../../core/casl/interfaces/space-ability.type';
import { PageAccessService } from '../../../core/page/page-access/page-access.service';
import { PageService } from '../../../core/page/services/page.service';
import { SearchService } from '../../../core/search/search.service';
import { ExportService } from '../../../integrations/export/export.service';
import { DomainService } from '../../../integrations/environment/domain.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import { AttachmentService } from '../../../core/attachment/services/attachment.service';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { WsService } from '../../../ws/ws.service';
import type { McpPrincipal } from '../mcp-auth.guard';
import { markdownLink, pageUrl } from './page-url';

/** The services tools use, injected once and shared by every request. */
@Injectable()
export class McpToolDeps {
  constructor(
    @InjectKysely() readonly db: KyselyDB,
    readonly pageRepo: PageRepo,
    readonly spaceRepo: SpaceRepo,
    readonly spaceMemberRepo: SpaceMemberRepo,
    readonly pagePermissionRepo: PagePermissionRepo,
    readonly spaceAbility: SpaceAbilityFactory,
    readonly pageAccess: PageAccessService,
    readonly pageService: PageService,
    readonly searchService: SearchService,
    readonly exportService: ExportService,
    readonly domainService: DomainService,
    // Write tools (S3b): content goes through the live collaboration doc,
    // files through core's attachment service.
    readonly collaborationGateway: CollaborationGateway,
    readonly environmentService: EnvironmentService,
    readonly attachmentService: AttachmentService,
    readonly attachmentRepo: AttachmentRepo,
    readonly wsService: WsService,
    @InjectQueue(QueueName.GENERAL_QUEUE) readonly generalQueue: Queue,
  ) {}
}

export type ReadableSpace = {
  id: string;
  name: string | null;
  slug: string;
  canWrite: boolean;
};

export type PageRef = {
  id: string;
  slugId: string;
  title: string | null;
  spaceId: string;
};

/**
 * Per-request view of the caller. Every permission decision goes through
 * Docmost's own checks: SpaceAbilityFactory (space roles, CASL) and
 * PageAccessService (page-level restrictions). Nothing here re-implements
 * a rule; it only decides which of those checks a tool needs.
 */
export class McpToolContext {
  private spacesPromise?: Promise<ReadableSpace[]>;

  constructor(
    readonly principal: McpPrincipal,
    readonly deps: McpToolDeps,
  ) {}

  get user() {
    return this.principal.user;
  }

  get workspace() {
    return this.principal.workspace;
  }

  get isAgent() {
    return this.principal.isAgent;
  }

  get cacheOpts() {
    return this.principal.skipPermissionCache ? { skipCache: true } : undefined;
  }

  get baseUrl(): string {
    return this.deps.domainService.getWorkspaceUrl(this.workspace);
  }

  /** Spaces the caller can read pages in, with whether it may also edit. */
  readableSpaces(): Promise<ReadableSpace[]> {
    this.spacesPromise ??= this.loadReadableSpaces();
    return this.spacesPromise;
  }

  private async loadReadableSpaces(): Promise<ReadableSpace[]> {
    const ids = await this.deps.spaceMemberRepo.getUserSpaceIds(this.user.id);
    const result: ReadableSpace[] = [];
    for (const id of [...new Set(ids)]) {
      const space = await this.findLiveSpace(id);
      if (!space) continue;
      const ability = await this.abilityFor(id);
      if (
        !ability ||
        ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)
      ) {
        continue;
      }
      result.push({
        id: space.id,
        name: space.name,
        slug: space.slug,
        canWrite: ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
      });
    }
    return result.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }

  async readableSpace(spaceIdOrSlug: string): Promise<ReadableSpace | null> {
    const spaces = await this.readableSpaces();
    return (
      spaces.find((s) => s.id === spaceIdOrSlug || s.slug === spaceIdOrSlug) ??
      null
    );
  }

  /**
   * The page if it exists in this workspace, is not trashed, and the caller
   * may view it (PageAccessService.validateCanView); otherwise null.
   */
  async findReadablePage(
    pageIdOrSlugId: string,
    opts: { includeContent?: boolean } = {},
  ): Promise<Page | null> {
    const page = await this.deps.pageRepo.findById(pageIdOrSlugId, {
      includeContent: opts.includeContent,
    });
    if (!page || page.deletedAt || page.workspaceId !== this.workspace.id) {
      return null;
    }
    try {
      await this.deps.pageAccess.validateCanView(
        page,
        this.user,
        this.cacheOpts,
      );
    } catch {
      return null;
    }
    return page;
  }

  /** Whether the caller may edit this page (for S3b write tools). */
  async canEditPage(page: Page): Promise<boolean> {
    try {
      await this.deps.pageAccess.validateCanEdit(page, this.user);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the caller may create pages in this space (for S3b). */
  async canCreateInSpace(spaceId: string): Promise<boolean> {
    try {
      await this.deps.pageAccess.validateCanCreate(spaceId, this.user);
      return true;
    } catch {
      return false;
    }
  }

  /** Narrows page ids to those the caller may view (page-level restrictions). */
  async filterAccessiblePageIds(pageIds: string[], spaceId?: string) {
    return this.deps.pagePermissionRepo.filterAccessiblePageIds({
      pageIds,
      userId: this.user.id,
      spaceId,
    });
  }

  pageUrl(page: PageRef, spaceSlug: string): string {
    return pageUrl(this.baseUrl, spaceSlug, page);
  }

  pageLink(page: PageRef, spaceSlug: string): string {
    return markdownLink(page.title, this.pageUrl(page, spaceSlug));
  }

  private async findLiveSpace(spaceId: string): Promise<Space | null> {
    const space = await this.deps.spaceRepo.findById(
      spaceId,
      this.workspace.id,
    );
    return space && !space.deletedAt ? space : null;
  }

  private async abilityFor(spaceId: string) {
    try {
      return await this.deps.spaceAbility.createForUser(
        this.user,
        spaceId,
        this.cacheOpts,
      );
    } catch {
      return null; // createForUser throws when the user has no role there
    }
  }
}

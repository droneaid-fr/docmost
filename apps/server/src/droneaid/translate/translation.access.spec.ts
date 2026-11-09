import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TranslationAccess } from './translation.access';

const PAGE: any = { id: 'p', workspaceId: 'ws', spaceId: 's', deletedAt: null };
const USER: any = { id: 'u' };

function setup(opts: {
  canEdit?: boolean;
  sharingAllowed?: boolean;
  share?: any;
  restricted?: boolean;
}) {
  const pageAccess = {
    validateCanEdit: jest.fn(async () => {
      if (opts.canEdit === false) throw new ForbiddenException();
    }),
    validateCanView: jest.fn(),
  };
  const shareService = {
    getShareForPage: jest
      .fn()
      .mockResolvedValue(
        opts.share === undefined ? { spaceId: 's' } : opts.share,
      ),
    isSharingAllowed: jest.fn().mockResolvedValue(opts.sharingAllowed ?? true),
  };
  const pagePermissionRepo = {
    hasRestrictedAncestor: jest
      .fn()
      .mockResolvedValue(opts.restricted ?? false),
  };
  const pageRepo = { findById: jest.fn().mockResolvedValue(PAGE) };
  return new TranslationAccess(
    pageRepo as any,
    pagePermissionRepo as any,
    pageAccess as any,
    shareService as any,
  );
}

describe('TranslationAccess (who may set languages and trigger updates)', () => {
  it('lets a user who can share a public page manage it', async () => {
    const access = setup({});
    expect(await access.canManage(PAGE, USER)).toBe(true);
    await expect(access.assertCanManage(PAGE, USER)).resolves.toBeUndefined();
  });

  it('refuses a reader (no edit right on the page)', async () => {
    const access = setup({ canEdit: false });
    expect(await access.canManage(PAGE, USER)).toBe(false);
    await expect(access.assertCanManage(PAGE, USER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses when public sharing is disabled for the space or workspace', async () => {
    const access = setup({ sharingAllowed: false });
    await expect(access.assertCanManage(PAGE, USER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses a page that is not shared to the web', async () => {
    const access = setup({ share: null });
    await expect(access.assertCanManage(PAGE, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('treats a restricted page as unpublished', async () => {
    const access = setup({ restricted: true });
    expect(await access.isPublished(PAGE)).toBe(false);
    await expect(access.assertCanManage(PAGE, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

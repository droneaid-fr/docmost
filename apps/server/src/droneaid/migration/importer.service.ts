import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { v7 as uuid7 } from 'uuid';
import slugify from '@sindresorhus/slugify';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { DatabaseData, generateNodeId } from '@docmost/editor-ext';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { BacklinkRepo } from '@docmost/db/repos/backlink/backlink.repo';
import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { SignupService } from '../../core/auth/services/signup.service';
import { SpaceService } from '../../core/space/services/space.service';
import { SpaceMemberService } from '../../core/space/services/space-member.service';
import { AttachmentService } from '../../core/attachment/services/attachment.service';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import { ShareService } from '../../core/share/share.service';
import { ImportService } from '../../integrations/import/services/import.service';
import { jsonToText } from '../../collaboration/collaboration.util';
import { generateSlugId } from '../../common/helpers';
import { AgentService } from '../agents/agent.service';
import { SignupRulesService } from '../signup-rules/signup-rules.service';
import { sourceHash } from '../translate/blocks';
import { droneaidDb } from '../db.types';
import {
  blobPath,
  Bundle,
  BundleBlob,
  BundleComment,
  BundleDatabase,
  BundleDoc,
  LoadedWorkspace,
  loadBundle,
  readDocFile,
  readDocJson,
} from './bundle';
import { convertDatabase } from './database-convert';
import { AttachmentInfo, convertMarkdown, PlannedPage } from './content';
import { ImportKind, ImportMapRepo } from './import-map.repo';
import { prepareMarkdown, PrepStats } from './markdown-prep';
import {
  agentReaderWorkspaces,
  planSignupRules,
  planSpaceMembers,
  planUsers,
  reviewGrants,
} from './roles';
import {
  docKey,
  flattenTree,
  folderCreatedAt,
  folderKey,
  planTree,
  TreeNode,
} from './tree';
import { ImportReport, newReport } from './report';
import { buildUrlMap } from './url-map';

export type ImportOptions = {
  bundleDir: string;
  ownerEmail: string;
  workspaceName: string;
  skipTrashed: boolean;
  agent: { name: string; workspaceName: string } | null;
};

type PageRecord = PlannedPage & { workspaceKey: string; created: boolean };

const randomPassword = () => randomBytes(32).toString('base64url');

/** Keys of blobs a doc shows in page mode (not those only on its canvas). */
export function pageBlobKeys(markdown: string): string[] {
  const keys = new Set<string>();
  for (const m of markdown.matchAll(/blob:\/\/([A-Za-z0-9_\-=+/]+)/g)) keys.add(m[1]);
  for (const m of markdown.matchAll(/<!--\s*affine-block\s[^>]*?\bblob="([^"]+)"/g)) {
    keys.add(decodeURIComponent(m[1]));
  }
  return [...keys].sort();
}

/** A file name Docmost's file route serves (no path separators). */
export function safeFileName(name: string, fallback: string): string {
  const clean = (name ?? '')
    .replace(/[/\\\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return clean || fallback;
}

@Injectable()
export class AffineImporter {
  private readonly logger = new Logger(AffineImporter.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly userRepo: UserRepo,
    private readonly pageRepo: PageRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly backlinkRepo: BacklinkRepo,
    private readonly commentRepo: CommentRepo,
    private readonly signupService: SignupService,
    private readonly spaceService: SpaceService,
    private readonly spaceMemberService: SpaceMemberService,
    private readonly attachmentService: AttachmentService,
    private readonly shareService: ShareService,
    private readonly importService: ImportService,
    private readonly agentService: AgentService,
    private readonly signupRules: SignupRulesService,
    private readonly mapRepo: ImportMapRepo,
  ) {}

  // ------------------------------------------------------------- state

  private bundle: Bundle;
  private workspace: Workspace;
  private map = new Map<string, string>();
  private report: ImportReport;
  private usersByEmail = new Map<string, User>();
  private affineUserEmail = new Map<string, string>();
  private spaceOf = new Map<string, { id: string; slug: string; creator: User }>();
  private pages = new Map<string, PageRecord>(); // `${wsId}/${key}`
  private docPage = new Map<string, PageRecord>(); // AFFiNE docId
  private attachmentsByBlob = new Map<string, AttachmentInfo>(); // `${docId}/${key}`
  private firstAttachmentOfBlob = new Map<string, AttachmentInfo>(); // `${wsId}/${key}`
  private shares = new Map<string, { key: string }>(); // docId
  private trees = new Map<string, TreeNode[]>(); // AFFiNE workspace id
  private backlinks: { sourcePageId: string; targetPageId: string; workspaceId: string }[] = [];

  private mapped(kind: ImportKind, sourceId: string): string | undefined {
    return this.map.get(`${kind}:${sourceId}`);
  }

  private async remember(kind: ImportKind, sourceId: string, targetId: string, trx?: any) {
    await this.mapRepo.put(this.workspace.id, this.bundle.sha256, kind, sourceId, targetId, trx);
    this.map.set(`${kind}:${sourceId}`, targetId);
  }

  private count(key: string, by = 1) {
    this.report.created[key] = (this.report.created[key] ?? 0) + by;
  }

  private skip(key: string, by = 1) {
    this.report.skippedExisting[key] = (this.report.skippedExisting[key] ?? 0) + by;
  }

  // ------------------------------------------------------------- run

  async run(opts: ImportOptions): Promise<ImportReport> {
    const started = Date.now();
    this.bundle = await loadBundle(opts.bundleDir);
    this.report = newReport(this.bundle, opts);
    const workspaces = this.bundle.workspaces.filter((w) => !!w.workspace);

    await this.ensureWorkspace(opts);
    await this.ensureUsers(opts.ownerEmail);
    for (const ws of workspaces) await this.ensureSpace(ws);
    if (opts.agent) await this.ensureAgent(opts.agent);
    for (const ws of workspaces) this.planPages(ws, opts.skipTrashed);
    await this.loadExistingPages();
    for (const ws of workspaces) await this.writePages(ws);
    await this.writeBacklinks();
    await this.ensureSignupRules();
    for (const ws of workspaces) {
      this.report.grantsNotReproduced.push(...reviewGrants(ws));
    }
    this.buildUrls();
    this.report.timingsMs.total = Date.now() - started;
    return this.report;
  }

  // ------------------------------------------------------------- workspace

  private async ensureWorkspace(opts: ImportOptions) {
    let workspace = await this.workspaceRepo.findFirst();
    if (!workspace) {
      const ownerUser = this.bundle.users.find(
        (u) => u.email.toLowerCase() === opts.ownerEmail.toLowerCase(),
      );
      if (!ownerUser) throw new Error(`Owner ${opts.ownerEmail} not in bundle`);
      const setup = await this.signupService.initialSetup({
        name: ownerUser.name || ownerUser.email.split('@')[0],
        email: ownerUser.email,
        password: randomPassword(),
        workspaceName: opts.workspaceName,
      } as any);
      workspace = setup.workspace;
      await this.userRepo.updateUser(
        { hasGeneratedPassword: true },
        setup.user.id,
        workspace.id,
      );
      this.report.workspaceCreated = true;
    }
    this.workspace = workspace;
    this.report.workspace = { id: workspace.id, name: workspace.name };

    const bundles = await this.mapRepo.bundles(workspace.id);
    const others = bundles.filter((sha) => sha !== this.bundle.sha256);
    if (others.length) {
      throw new Error(
        `This Docmost already holds an import of another bundle (${others.join(', ')}). ` +
          'Import into an empty Docmost, or re-run with the same bundle.',
      );
    }
    this.report.rerun = bundles.length > 0;
    this.map = await this.mapRepo.all(workspace.id);
    if (!bundles.length) {
      await this.remember('bundle', this.bundle.sha256, workspace.id);
    }
  }

  // ------------------------------------------------------------- users

  private async ensureUsers(ownerEmail: string) {
    const { users, skipped } = planUsers(this.bundle, ownerEmail);
    this.report.skippedUsers = skipped;
    for (const u of this.bundle.users) this.affineUserEmail.set(u.id, u.email.toLowerCase());

    for (const { user, workspaceRole } of users) {
      const email = user.email.toLowerCase();
      let existing = await this.userRepo.findByEmail(email, this.workspace.id);
      const fresh = !existing;
      if (fresh) {
        existing = await this.signupService.signup(
          {
            email,
            name: user.name?.trim() || undefined,
            password: randomPassword(),
          } as any,
          this.workspace.id,
        );
      }
      const firstTime = !this.mapped('user', user.id);
      if (firstTime) {
        // Same settings as a Google signup (S2a): no usable password,
        // verified address; plus the AFFiNE role, avatar and dates.
        await this.userRepo.updateUser(
          {
            role: workspaceRole,
            hasGeneratedPassword: fresh ? true : undefined,
            emailVerifiedAt: user.emailVerified ? new Date(user.emailVerified) : new Date(),
            avatarUrl: user.avatarUrl?.startsWith('http') ? user.avatarUrl : undefined,
            name: user.name?.trim() || undefined,
            createdAt: new Date(user.createdAt),
            deactivatedAt: user.disabled ? new Date() : undefined,
          },
          existing.id,
          this.workspace.id,
        );
        await this.remember('user', user.id, existing.id);
        this.count(fresh ? 'users' : 'usersMatchedExisting');
      } else {
        this.skip('users');
      }
      this.usersByEmail.set(email, existing);
    }
  }

  private userFor(principal: { email?: string | null; userId?: string | null } | null) {
    const email =
      principal?.email?.toLowerCase() ??
      (principal?.userId ? this.affineUserEmail.get(principal.userId) : undefined);
    return email ? this.usersByEmail.get(email) : undefined;
  }

  // ------------------------------------------------------------- spaces

  private async uniqueSlug(name: string): Promise<string> {
    const base = (slugify(name, { decamelize: false }) || 'space').replace(/^[^a-z0-9]+/, '').slice(0, 90) || 'space';
    let slug = base;
    for (let i = 2; await this.spaceRepo.slugExists(slug, this.workspace.id); i++) {
      slug = `${base}-${i}`;
    }
    return slug;
  }

  private async ensureSpace(ws: LoadedWorkspace) {
    const info = ws.workspace;
    const owner = this.userFor(info.owner) ?? this.usersByEmail.get(this.report.options.ownerEmail);
    let spaceId = this.mapped('space', info.id);
    let space = spaceId ? await this.spaceRepo.findById(spaceId, this.workspace.id) : null;
    if (!space) {
      space = await this.spaceService.createSpace(owner, this.workspace.id, {
        name: info.name,
        slug: await this.uniqueSlug(info.name),
      } as any);
      spaceId = space.id;
      await this.remember('space', info.id, space.id);
      this.count('spaces');
    } else {
      this.skip('spaces');
    }
    this.spaceOf.set(info.id, { id: space.id, slug: space.slug, creator: owner });

    const { members, skipped } = planSpaceMembers(ws);
    this.report.skippedMembers.push(...skipped);
    for (const member of members) {
      const user = this.usersByEmail.get(member.email);
      if (!user) {
        this.report.skippedMembers.push({
          workspace: info.name,
          email: member.email,
          role: member.affineRole,
          state: 'active',
          reason: 'user not imported',
        });
        continue;
      }
      await this.addMember(space.id, user.id, member.role);
    }
    this.report.spaces.push({
      workspaceId: info.id,
      name: info.name,
      spaceId: space.id,
      slug: space.slug,
      members: members.map((m) => `${m.email}:${m.role}`),
    });
  }

  private async addMember(spaceId: string, userId: string, role: string) {
    const existing = await this.spaceMemberRepo.getSpaceMemberByTypeId(spaceId, { userId });
    if (existing) return false;
    await this.spaceMemberService.addUserToSpace(userId, spaceId, role, this.workspace.id);
    this.count('spaceMembers');
    return true;
  }

  // ------------------------------------------------------------- agent

  private async ensureAgent(opts: { name: string; workspaceName: string }) {
    const ws = this.bundle.workspaces.find((w) => w.workspace.name === opts.workspaceName);
    if (!ws) throw new Error(`Agent workspace "${opts.workspaceName}" not in bundle`);
    const affineAgent = this.bundle.agents.find((a) => a.workspaceId === ws.workspace.id);
    const space = this.spaceOf.get(ws.workspace.id);
    const owner = this.usersByEmail.get(this.report.options.ownerEmail);
    const email = (affineAgent?.email ?? `${space.slug}.agent@agents.invalid`).toLowerCase();

    let agentUserId = this.mapped('agent', ws.workspace.id);
    if (!agentUserId) {
      const created = await this.agentService.createAgent(owner, this.workspace, {
        name: opts.name,
        email,
        spaceId: space.id,
      });
      agentUserId = created.userId;
      await this.remember('agent', ws.workspace.id, agentUserId);
      this.count('agents');
    } else {
      this.skip('agents');
    }
    const agentUser = await this.userRepo.findById(agentUserId, this.workspace.id);
    this.usersByEmail.set(email, agentUser);
    if (affineAgent) this.affineUserEmail.set(affineAgent.userId, email);

    const readers = agentReaderWorkspaces(this.bundle.workspaces, email, ws.workspace.id);
    for (const r of readers) {
      const target = this.spaceOf.get(r.workspaceId);
      if (target) await this.addMember(target.id, agentUserId, 'reader');
    }
    this.report.agent = {
      userId: agentUserId,
      email,
      name: agentUser?.name ?? opts.name,
      writableSpace: space.slug,
      readerSpaces: readers.map((r) => ({ space: r.name, grants: r.grants })),
      ownGrants: affineAgent?.grants.length ?? 0,
    };
  }

  // ------------------------------------------------------------- pages: plan

  private planPages(ws: LoadedWorkspace, skipTrashed: boolean) {
    const docs = ws.docs.filter((d) => !(skipTrashed && d.trash));
    if (skipTrashed) this.report.trashedSkipped += ws.docs.length - docs.length;
    const plan = planTree(ws.folders, docs);
    this.report.multiFolderDocs.push(
      ...plan.extraLinks.map((l) => ({
        workspace: ws.workspace.name,
        docId: l.docId,
        title: docs.find((d) => d.docId === l.docId)?.title ?? '',
        keptUnder: l.keptUnder.join(' / '),
        alsoIn: l.alsoIn.map((p) => p.join(' / ')),
      })),
    );
    this.report.skippedFolderLinks.push(
      ...[...plan.skippedLinks, ...plan.missingDocs].map((l) => ({
        workspace: ws.workspace.name,
        folder: l.folderPath.join(' / '),
        type: l.type,
        targetId: l.targetId,
      })),
    );
    const space = this.spaceOf.get(ws.workspace.id);
    const titles = new Map(docs.map((d) => [d.docId, d.title] as const));
    const nodes = flattenTree(plan.roots);
    for (const { node } of nodes) {
      const sourceId = this.sourceIdOf(ws, node);
      const existing = this.mapped('page', sourceId);
      const record: PageRecord = {
        id: existing ?? uuid7(),
        slugId: existing ? '' : generateSlugId(),
        title: node.kind === 'folder' ? node.title : titles.get(node.docId) || null,
        spaceId: space.id,
        workspaceKey: ws.workspace.id,
        created: !existing,
      };
      this.pages.set(`${ws.workspace.id}/${node.key}`, record);
      if (node.kind === 'doc') this.docPage.set(node.docId, record);
    }
    this.trees.set(ws.workspace.id, plan.roots);
  }

  private sourceIdOf(ws: LoadedWorkspace, node: TreeNode) {
    return node.kind === 'folder'
      ? `${ws.workspace.id}/${folderKey(node.folderId)}`
      : `${ws.workspace.id}/${docKey(node.docId)}`;
  }

  /** Slug ids of pages from an earlier run (needed for links and URLs). */
  private async loadExistingPages() {
    const existing = [...this.pages.values()].filter((p) => !p.created);
    for (const page of existing) {
      const row = await this.pageRepo.findById(page.id);
      if (!row) {
        throw new Error(
          `Import map points at page ${page.id}, which no longer exists. ` +
            'Reset the import (see RUNBOOK) instead of re-running on a partial delete.',
        );
      }
      page.slugId = row.slugId;
      page.title = row.title;
    }
  }

  // ------------------------------------------------------------- pages: write

  private async writePages(ws: LoadedWorkspace) {
    const roots = this.trees.get(ws.workspace.id) ?? [];
    const docs = new Map(ws.docs.map((d) => [d.docId, d] as const));
    const blobs = new Map(ws.blobs.map((b) => [b.key, b] as const));

    const writeLevel = async (nodes: TreeNode[], parent: PageRecord | null) => {
      let prev: string | null = null;
      for (const node of nodes) {
        const position = generateJitteredKeyBetween(prev, null);
        prev = position;
        const record = this.pages.get(`${ws.workspace.id}/${node.key}`);
        if (record.created) {
          if (node.kind === 'folder') {
            await this.insertFolder(ws, node, record, parent, position);
          } else {
            await this.insertDoc(ws, docs.get(node.docId), blobs, record, parent, position);
          }
        } else {
          this.skip(node.kind === 'folder' ? 'folderPages' : 'docPages');
          if (node.kind === 'doc') await this.collectExisting(ws, docs.get(node.docId), blobs);
        }
        await writeLevel(node.children, record);
      }
    };
    await writeLevel(roots, null);
  }

  private async insertPageRow(
    record: PageRecord,
    values: {
      title: string | null;
      content: any;
      parent: PageRecord | null;
      position: string;
      creatorId: string;
      lastUpdatedById: string;
      createdAt: Date;
      updatedAt: Date;
    },
    sourceId: string,
  ) {
    const ydoc = await this.importService.createYdoc(values.content);
    await executeTx(this.db, async (trx) => {
      await this.pageRepo.insertPage(
        {
          id: record.id,
          slugId: record.slugId,
          title: values.title,
          content: values.content,
          textContent: jsonToText(values.content),
          ydoc,
          position: values.position,
          spaceId: record.spaceId,
          workspaceId: this.workspace.id,
          parentPageId: values.parent?.id ?? null,
          creatorId: values.creatorId,
          lastUpdatedById: values.lastUpdatedById,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt,
        },
        trx,
      );
      await this.remember('page', sourceId, record.id, trx);
    });
  }

  private async insertFolder(
    ws: LoadedWorkspace,
    node: Extract<TreeNode, { kind: 'folder' }>,
    record: PageRecord,
    parent: PageRecord | null,
    position: string,
  ) {
    const space = this.spaceOf.get(ws.workspace.id);
    const created = folderCreatedAt(
      node,
      (docId) => ws.docs.find((d) => d.docId === docId)?.createdAt,
    );
    const when = created ? new Date(created) : new Date();
    await this.insertPageRow(
      record,
      {
        title: node.title,
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        parent,
        position,
        creatorId: space.creator.id,
        lastUpdatedById: space.creator.id,
        createdAt: when,
        updatedAt: when,
      },
      this.sourceIdOf(ws, node),
    );
    this.count('folderPages');
  }

  private pageForRef = (ref: string): PlannedPage | null => this.docPage.get(ref) ?? null;

  private spaceSlugOf = (spaceId: string) =>
    [...this.spaceOf.values()].find((s) => s.id === spaceId)?.slug ?? null;

  private async uploadDocBlobs(
    ws: LoadedWorkspace,
    doc: BundleDoc,
    blobs: Map<string, BundleBlob>,
    record: PageRecord,
    keys: string[],
    creator: User,
  ) {
    const names = new Map<string, string>();
    for (const m of (await readDocFile(this.bundle, doc, doc.body) ?? '').matchAll(
      /<!--\s*affine-block\s[^>]*?\bblob="([^"]+)"[^>]*?\bname="([^"]*)"/g,
    )) {
      names.set(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    }
    for (const key of keys) {
      const source = `${doc.docId}/${key}`;
      const blob = blobs.get(key);
      if (!blob) {
        this.report.missingBlobs.push({ docId: doc.docId, key });
        continue;
      }
      const mappedId = this.mapped('attachment', source);
      let attachment = mappedId ? await this.attachmentRepo.findById(mappedId) : null;
      if (!attachment) {
        const id = uuid7();
        const ext = path.extname(blob.file) || '';
        const fileName = safeFileName(
          names.get(key) ?? '',
          `${blob.mime?.startsWith('image/') ? 'image' : 'file'}-${id.slice(-12)}${ext}`,
        );
        const filePath = `${getAttachmentFolderPath(AttachmentType.File, this.workspace.id)}/${id}/${fileName}`;
        const data = await fs.readFile(blobPath(this.bundle, blob));
        await this.attachmentService.uploadToDrive(filePath, data);
        attachment = await this.attachmentService.saveAttachment({
          attachmentId: id,
          preparedFile: {
            fileName,
            fileSize: data.byteLength,
            fileExtension: path.extname(fileName) || ext,
            mimeType: blob.mime,
          },
          filePath,
          type: AttachmentType.File,
          userId: creator.id,
          workspaceId: this.workspace.id,
          pageId: record.id,
          spaceId: record.spaceId,
        });
        await this.remember('attachment', source, attachment.id);
        this.count('attachments');
      } else {
        this.skip('attachments');
      }
      const info: AttachmentInfo = {
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSize: Number(attachment.fileSize ?? 0) || null,
        workspaceId: attachment.workspaceId,
      };
      this.attachmentsByBlob.set(source, info);
      const wsKey = `${ws.workspace.id}/${key}`;
      if (!this.firstAttachmentOfBlob.has(wsKey)) this.firstAttachmentOfBlob.set(wsKey, info);
    }
  }

  private async docDatabases(doc: BundleDoc): Promise<Map<string, DatabaseData>> {
    const out = new Map<string, DatabaseData>();
    const people = new Map(
      this.bundle.users.map((u) => [u.id, u.name || u.email] as const),
    );
    const used = new Set<string>();
    for (const entry of doc.databases ?? []) {
      const source = await readDocJson<BundleDatabase>(this.bundle, doc, entry.file);
      const result = convertDatabase(source, {
        people,
        usedDatabaseIds: used,
        freshId: () => generateNodeId(),
      });
      out.set(source.databaseId, result.data);
      this.report.databases.push({
        docId: doc.docId,
        docTitle: doc.title,
        databaseId: result.data.id,
        title: result.data.title,
        rows: result.data.rows.length,
        columns: result.data.columns.length,
        bundleRows: source.rowCount,
        bundleColumns: source.columns.length,
        renamedIds: result.renamedIds.length,
        invalidCells: result.invalidCells.length,
        hiddenColumns: result.hiddenColumns,
        notes: result.notes,
      });
    }
    return out;
  }

  private addPrepStats(doc: BundleDoc, stats: PrepStats) {
    const f = this.report.formatting;
    f.colorSpans += stats.colorSpans;
    f.colorSpansDropped += stats.colorSpansDropped;
    for (const [k, v] of Object.entries(stats.markers)) f.markers[k] = (f.markers[k] ?? 0) + v;
    f.markersDropped.push(...stats.markersDropped.map((m) => `${doc.docId}: ${m}`));
    f.backgroundDropped += doc.inline?.attributes?.background ?? 0;
    const canvas = (doc.blocks ?? []).filter((b) => b.handling === 'canvas');
    f.canvasBlocksDropped += canvas.filter(
      (b) => !/^affine:(bookmark|embed-|surface$)/.test(b.flavour),
    ).length;
  }

  private async convertBody(
    doc: BundleDoc,
    markdown: string,
    title: string | null,
    record: PageRecord,
    creator: User,
    databases: Map<string, DatabaseData>,
    extra: { edgelessNotes?: string | null; canvasBlocks?: any[] },
  ) {
    const prep = prepareMarkdown(
      markdown,
      {
        attachmentFor: (key) => this.attachmentsByBlob.get(`${doc.docId}/${key}`)?.id ?? null,
        titleOf: (docId) => this.docPage.get(docId)?.title ?? null,
      },
      extra,
    );
    const unresolved = prep.affineLinks.filter((id) => !this.docPage.has(id));
    const result = await convertMarkdown(
      prep.markdown,
      title,
      {
        baseUrl: '',
        workspaceId: this.workspace.id,
        userId: creator.id,
        pageFor: this.pageForRef,
        spaceSlug: this.spaceSlugOf,
        attachment: async (id) => {
          const a = await this.attachmentRepo.findById(id);
          return a
            ? {
                id: a.id,
                fileName: a.fileName,
                mimeType: a.mimeType,
                fileSize: Number(a.fileSize ?? 0) || null,
                workspaceId: a.workspaceId,
              }
            : null;
        },
      },
      {
        tokens: prep.tokens,
        databases,
        blobAttachment: (key) => this.attachmentsByBlob.get(`${doc.docId}/${key}`) ?? null,
      },
    );
    return { prep, result, unresolved };
  }

  private async insertDoc(
    ws: LoadedWorkspace,
    doc: BundleDoc,
    blobs: Map<string, BundleBlob>,
    record: PageRecord,
    parent: PageRecord | null,
    position: string,
  ) {
    const t0 = Date.now();
    const space = this.spaceOf.get(ws.workspace.id);
    const creator = this.userFor(doc.createdBy) ?? space.creator;
    const updater = this.userFor(doc.updatedBy) ?? creator;
    if (!this.userFor(doc.createdBy)) {
      this.report.creatorFallbacks.push({
        docId: doc.docId,
        affineCreator: doc.createdBy?.email ?? null,
        usedInstead: creator.email,
      });
    }

    const body = (await readDocFile(this.bundle, doc, doc.body)) ?? '';
    const edgelessNotes = await readDocFile(this.bundle, doc, doc.edgelessNotes?.file);
    const translations = [];
    for (const tr of doc.translations ?? []) {
      translations.push({ tr, markdown: (await readDocFile(this.bundle, doc, tr.file)) ?? '' });
    }
    const keys = [
      ...new Set([body, ...translations.map((t) => t.markdown)].flatMap(pageBlobKeys)),
    ].sort();
    await this.uploadDocBlobs(ws, doc, blobs, record, keys, creator);
    const databases = await this.docDatabases(doc);

    const { prep, result, unresolved } = await this.convertBody(
      doc,
      body,
      doc.title || null,
      record,
      creator,
      databases,
      { edgelessNotes, canvasBlocks: doc.blocks },
    );
    this.addPrepStats(doc, prep.stats);
    for (const id of unresolved) {
      this.report.unresolvedLinks.push({ docId: doc.docId, title: doc.title, target: id });
    }
    this.report.resolvedLinks += prep.affineLinks.length - unresolved.length;
    if (result.warnings.length) this.report.warnings.push(...result.warnings.map((w) => `${doc.docId}: ${w}`));
    if (result.databasesMissing.length) {
      this.report.warnings.push(`${doc.docId}: duplicate/unknown database markers ${result.databasesMissing.join(', ')}`);
    }

    await this.insertPageRow(
      record,
      {
        title: doc.title || null,
        content: result.json,
        parent,
        position,
        creatorId: creator.id,
        lastUpdatedById: updater.id,
        createdAt: new Date(doc.createdAt),
        updatedAt: new Date(doc.updatedAt),
      },
      `${ws.workspace.id}/${docKey(doc.docId)}`,
    );
    this.count('docPages');
    for (const target of result.linkedPageIds) {
      if (target !== record.id) {
        this.backlinks.push({ sourcePageId: record.id, targetPageId: target, workspaceId: this.workspace.id });
      }
    }

    if (doc.trash) {
      await this.pageRepo.removePage(record.id, updater.id, this.workspace.id);
      this.count('trashedPages');
      this.report.trashed.push({ docId: doc.docId, title: doc.title, affineTrashDate: doc.trashDate });
    } else if (doc.publish?.published) {
      await this.ensureShare(doc, record, creator);
    }
    await this.writeTranslations(doc, record, creator, databases, translations, result.json);
    await this.writeComments(doc, record);
    this.report.timingsMs.pages[doc.docId] = Date.now() - t0;
  }

  /** On a re-run: what URL map and backlinks need from an imported doc. */
  private async collectExisting(ws: LoadedWorkspace, doc: BundleDoc, blobs: Map<string, BundleBlob>) {
    for (const [source, id] of this.map) {
      if (!source.startsWith(`attachment:${doc.docId}/`)) continue;
      const key = source.slice(`attachment:${doc.docId}/`.length);
      const a = await this.attachmentRepo.findById(id);
      if (!a || !blobs.has(key)) continue;
      const info = { id: a.id, fileName: a.fileName, mimeType: a.mimeType, fileSize: null, workspaceId: a.workspaceId };
      this.attachmentsByBlob.set(`${doc.docId}/${key}`, info);
      const wsKey = `${ws.workspace.id}/${key}`;
      if (!this.firstAttachmentOfBlob.has(wsKey)) this.firstAttachmentOfBlob.set(wsKey, info);
    }
    const shareId = this.mapped('share', doc.docId);
    if (shareId) {
      const share = await this.db.selectFrom('shares').select(['key']).where('id', '=', shareId).executeTakeFirst();
      if (share) this.shares.set(doc.docId, { key: share.key });
    }
    if (doc.trash) this.report.trashed.push({ docId: doc.docId, title: doc.title, affineTrashDate: doc.trashDate });
  }

  private async ensureShare(doc: BundleDoc, record: PageRecord, creator: User) {
    if (this.mapped('share', doc.docId)) return;
    const page = await this.pageRepo.findById(record.id);
    const share = await this.shareService.createShare({
      authUserId: creator.id,
      workspaceId: this.workspace.id,
      page,
      createShareDto: { pageId: page.id, includeSubPages: false, searchIndexing: false } as any,
    });
    await this.remember('share', doc.docId, share.id);
    this.shares.set(doc.docId, { key: share.key });
    this.count('shares');
  }

  private async writeTranslations(
    doc: BundleDoc,
    record: PageRecord,
    creator: User,
    databases: Map<string, DatabaseData>,
    translations: { tr: BundleDoc['translations'][number]; markdown: string }[],
    content: any,
  ) {
    if (!translations.length) return;
    const hash = sourceHash(doc.title || null, content);
    const tdb = droneaidDb(this.db);
    for (const { tr, markdown } of translations) {
      const source = `${doc.docId}/${tr.lang}`;
      if (this.mapped('translation', source)) continue;
      const ready = tr.status === 'ready' && !!markdown.trim();
      let translated: any = null;
      if (ready) {
        const { result } = await this.convertBody(doc, markdown, tr.title, record, creator, databases, {});
        translated = result.json;
      }
      const row = await tdb
        .insertInto('droneaidPageTranslations')
        .values({
          workspaceId: this.workspace.id,
          pageId: record.id,
          lang: tr.lang,
          sourceLang: tr.sourceLang,
          status: ready ? 'ready' : 'pending',
          title: ready ? tr.title : null,
          content: translated,
          sourceHash: ready ? hash : null,
          translatedAt: ready ? new Date() : null,
        } as any)
        .onConflict((oc) => oc.columns(['pageId', 'lang']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (row) {
        await this.remember('translation', source, row.id);
        this.count(ready ? 'translations' : 'translationsQueued');
      }
    }
  }

  private commentJson(text: string) {
    const paragraphs = (text ?? '').split(/\n+/).filter((p) => p.trim());
    return {
      type: 'doc',
      content: (paragraphs.length ? paragraphs : ['']).map((p) => ({
        type: 'paragraph',
        ...(p ? { content: [{ type: 'text', text: p }] } : {}),
      })),
    };
  }

  private async writeComments(doc: BundleDoc, record: PageRecord) {
    if (!doc.comments) return;
    const comments = await readDocJson<BundleComment[]>(this.bundle, doc, doc.comments);
    const space = this.spaceOf.get(doc.workspaceId);
    const insert = async (c: BundleComment, parentId: string | null, resolved: boolean) => {
      if (c.deletedAt) return null;
      const existing = this.mapped('comment', c.id);
      if (existing) return existing;
      const author = this.userFor(c.author) ?? space.creator;
      const prefix = resolved ? '[resolved in AFFiNE] ' : '';
      const row = await this.commentRepo.insertComment({
        pageId: record.id,
        content: this.commentJson(prefix + (c.text ?? '')) as any,
        selection: null,
        type: 'page',
        parentCommentId: parentId,
        creatorId: author.id,
        workspaceId: this.workspace.id,
        spaceId: record.spaceId,
        createdAt: new Date(c.createdAt),
      } as any);
      await this.remember('comment', c.id, row.id);
      this.count('comments');
      this.report.comments.push({ docId: doc.docId, commentId: row.id, resolved, reply: !!parentId });
      return row.id;
    };
    for (const c of comments) {
      const resolved = c.resolved === true;
      const id = await insert(c, null, resolved);
      if (!id) continue;
      for (const reply of c.replies ?? []) await insert(reply, id, resolved);
    }
  }

  private async writeBacklinks() {
    if (!this.backlinks.length) return;
    for (let i = 0; i < this.backlinks.length; i += 100) {
      await this.backlinkRepo.insertBacklink(this.backlinks.slice(i, i + 100) as any);
    }
    this.count('backlinks', this.backlinks.length);
  }

  // ------------------------------------------------------------- signup rules

  private async ensureSignupRules() {
    const { rules, skipped } = planSignupRules(this.bundle.signupAllowlist);
    this.report.signupRules = { rules: [], skipped };
    if (this.mapped('signup-rules', 'allowlist')) {
      this.skip('signupRules');
      return;
    }
    const existing = await this.signupRules.listRules(this.workspace.id);
    const added = rules.map((r) => ({
      pattern: r.pattern,
      spaceRole: r.spaceRole as any,
      spaceIds: r.workspaceIds
        .map((w) => this.spaceOf.get(w)?.id)
        .filter((id): id is string => !!id),
    }));
    const kept = existing.filter((e) => !added.some((a) => a.pattern === e.pattern));
    // Google signup open, as in production (signup was open to droneaid.fr).
    await this.signupRules.saveRules(
      this.workspace.id,
      [
        ...kept.map((e) => ({ id: e.id, pattern: e.pattern, spaceIds: e.spaceIds, spaceRole: e.spaceRole as any })),
        ...added,
      ],
      true,
    );
    await this.remember('signup-rules', 'allowlist', this.workspace.id);
    this.count('signupRules', added.length);
    this.report.signupRules.rules = added.map((a) => ({
      pattern: a.pattern,
      spaceRole: a.spaceRole,
      spaces: a.spaceIds.map((id) => this.spaceSlugOf(id)),
    }));
  }

  // ------------------------------------------------------------- URL map

  private buildUrls() {
    const pageUrl = (p: PlannedPage) =>
      `/s/${this.spaceSlugOf(p.spaceId)}/p/${slugify((p.title || 'untitled').substring(0, 70))}-${p.slugId}`;
    const { mapped, unmapped } = buildUrlMap(this.bundle.oldUrls.paths, {
      page: (_ws, docId) => {
        const p = this.docPage.get(docId);
        return p ? pageUrl(p) : null;
      },
      share: (_ws, docId) => {
        const p = this.docPage.get(docId);
        const s = this.shares.get(docId);
        return p && s
          ? `/share/${s.key}/p/${slugify((p.title || 'untitled').substring(0, 70))}-${p.slugId}`
          : null;
      },
      space: (ws) => {
        const s = this.spaceOf.get(ws);
        return s ? `/s/${s.slug}` : null;
      },
      blob: (ws, key) => {
        const a = this.firstAttachmentOfBlob.get(`${ws}/${key}`);
        return a ? `/api/files/${a.id}/${encodeURIComponent(a.fileName)}` : null;
      },
    });
    this.report.urlMap = { mapped, unmapped };
  }
}

import { Module } from '@nestjs/common';
import { TokenModule } from '../../core/auth/token.module';
import { PageModule } from '../../core/page/page.module';
import { SearchModule } from '../../core/search/search.module';
import { ExportService } from '../../integrations/export/export.service';
import { AgentsModule } from '../agents/agents.module';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpBodyLimit } from './mcp-body-limit';
import { McpController } from './mcp.controller';
import { McpHttpService } from './mcp-http.service';
import { McpToolDeps } from './tools/context';

@Module({
  imports: [AgentsModule, TokenModule, PageModule, SearchModule],
  controllers: [McpController],
  providers: [
    McpBodyLimit,
    McpAuthGuard,
    McpHttpService,
    McpToolDeps,
    // ExportModule does not export its service; it is stateless, so we keep
    // our own instance instead of editing the upstream module.
    ExportService,
  ],
})
export class McpModule {}

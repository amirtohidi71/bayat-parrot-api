import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AdminAuthGuard,
  AdminTokenPayload,
} from '../admin/guards/admin-auth.guard';
import { ChatMessagesQueryDto } from './dto/chat-messages-query.dto';
import { ReassignChatConversationDto } from './dto/reassign-chat-conversation.dto';
import { SalesChatSupervisorQueryDto } from './dto/sales-chat-supervisor-query.dto';
import { SalesChatSupervisorGuard } from './guards/sales-chat-supervisor.guard';
import { SalesChatService } from './sales-chat.service';

type SupervisorRequest = Request & { admin?: AdminTokenPayload };

const uuidV4Pipe = new ParseUUIDPipe({ version: '4' });

@Controller('admin-panel/sales-chat')
@UseGuards(AdminAuthGuard, SalesChatSupervisorGuard)
export class SupervisorSalesChatController {
  constructor(private readonly chat: SalesChatService) {}

  @Get('agents')
  agents() {
    return this.chat.listActiveAgents();
  }

  @Get('conversations')
  conversations(@Query() query: SalesChatSupervisorQueryDto) {
    return this.chat.listSupervisorConversations(query);
  }

  @Get('conversations/:conversationId/messages')
  messages(
    @Param('conversationId', uuidV4Pipe) conversationId: string,
    @Query() query: ChatMessagesQueryDto,
  ) {
    return this.chat.getSupervisorMessages(conversationId, query);
  }

  @Post('conversations/:conversationId/reassign')
  reassign(
    @Param('conversationId', uuidV4Pipe) conversationId: string,
    @Body() dto: ReassignChatConversationDto,
    @Req() request: SupervisorRequest,
  ) {
    return this.chat.reassignConversation(
      conversationId,
      dto.agentId,
      request.admin!.username,
    );
  }

  @Post('conversations/:conversationId/close')
  close(@Param('conversationId', uuidV4Pipe) conversationId: string) {
    return this.chat.closeSupervisorConversation(conversationId);
  }

  @Post('conversations/:conversationId/reopen')
  reopen(@Param('conversationId', uuidV4Pipe) conversationId: string) {
    return this.chat.reopenSupervisorConversation(conversationId);
  }
}

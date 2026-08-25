import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ChatPushService } from './chat-push.service';
import { ChatMessagesQueryDto } from './dto/chat-messages-query.dto';
import {
  SubscribeChatPushDto,
  UnsubscribeChatPushDto,
} from './dto/chat-push-subscription.dto';
import { MarkChatReadDto } from './dto/mark-chat-read.dto';
import { SalesAgentLoginDto } from './dto/sales-agent-login.dto';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { SalesAgentAuthGuard } from './guards/sales-agent-auth.guard';
import type { SalesAgentRequest } from './guards/sales-agent-auth.guard';
import { SalesChatThrottlerGuard } from './guards/sales-chat-throttler.guard';
import { SalesChatAuthService } from './sales-chat-auth.service';
import { SalesChatService } from './sales-chat.service';

const uuidV4Pipe = new ParseUUIDPipe({ version: '4' });

@Controller('sales-chat/agent')
@UseGuards(SalesChatThrottlerGuard)
@Throttle({ default: { limit: 240, ttl: 15 * 60 * 1000 } })
export class AgentSalesChatController {
  constructor(
    private readonly auth: SalesChatAuthService,
    private readonly chat: SalesChatService,
    private readonly push: ChatPushService,
  ) {}

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  login(@Body() dto: SalesAgentLoginDto) {
    return this.auth.login(dto);
  }

  @Get('queue')
  @UseGuards(SalesAgentAuthGuard)
  queue(@Req() request: SalesAgentRequest) {
    const agent = request.salesAgent!;
    return this.chat.listAgentQueue(agent.agentId, agent.agentScope);
  }

  @Get('conversations')
  @UseGuards(SalesAgentAuthGuard)
  conversations(@Req() request: SalesAgentRequest) {
    const agent = request.salesAgent!;
    return this.chat.listAgentConversations(agent.agentId, agent.agentScope);
  }

  @Get('conversations/unread-count')
  @UseGuards(SalesAgentAuthGuard)
  unreadCount(@Req() request: SalesAgentRequest) {
    const agent = request.salesAgent!;
    return this.chat.getAgentUnreadCount(agent.agentId, agent.agentScope);
  }

  @Post('conversations/:conversationId/claim')
  @UseGuards(SalesAgentAuthGuard)
  claim(
    @Req() request: SalesAgentRequest,
    @Param('conversationId', uuidV4Pipe) conversationId: string,
  ) {
    const agent = request.salesAgent!;
    return this.chat.claimConversation(
      agent.agentId,
      agent.agentScope,
      conversationId,
    );
  }

  @Get('conversations/:conversationId/messages')
  @UseGuards(SalesAgentAuthGuard)
  messages(
    @Req() request: SalesAgentRequest,
    @Param('conversationId', uuidV4Pipe) conversationId: string,
    @Query() query: ChatMessagesQueryDto,
  ) {
    const agent = request.salesAgent!;
    return this.chat.getAgentMessages(
      agent.agentId,
      agent.agentScope,
      conversationId,
      query,
    );
  }

  @Post('conversations/:conversationId/messages')
  @UseGuards(SalesAgentAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60 * 1000 } })
  sendMessage(
    @Req() request: SalesAgentRequest,
    @Param('conversationId', uuidV4Pipe) conversationId: string,
    @Body() dto: SendChatMessageDto,
  ) {
    const agent = request.salesAgent!;
    return this.chat.sendAgentMessage(
      agent.agentId,
      agent.agentScope,
      conversationId,
      dto,
    );
  }

  @Post('conversations/:conversationId/read')
  @UseGuards(SalesAgentAuthGuard)
  markRead(
    @Req() request: SalesAgentRequest,
    @Param('conversationId', uuidV4Pipe) conversationId: string,
    @Body() dto: MarkChatReadDto,
  ) {
    const agent = request.salesAgent!;
    return this.chat.markAgentRead(
      agent.agentId,
      agent.agentScope,
      conversationId,
      dto,
    );
  }

  @Post('conversations/:conversationId/close')
  @UseGuards(SalesAgentAuthGuard)
  close(
    @Req() request: SalesAgentRequest,
    @Param('conversationId', uuidV4Pipe) conversationId: string,
  ) {
    const agent = request.salesAgent!;
    return this.chat.closeAgentConversation(
      agent.agentId,
      agent.agentScope,
      conversationId,
    );
  }

  @Get('push-config')
  @UseGuards(SalesAgentAuthGuard)
  pushConfig() {
    return this.push.getPublicConfig();
  }

  @Post('push-subscriptions')
  @UseGuards(SalesAgentAuthGuard)
  subscribe(
    @Req() request: SalesAgentRequest,
    @Body() dto: SubscribeChatPushDto,
  ) {
    return this.push.subscribeAgent(request.salesAgent!.agentId, dto);
  }

  @Delete('push-subscriptions')
  @UseGuards(SalesAgentAuthGuard)
  unsubscribe(
    @Req() request: SalesAgentRequest,
    @Body() dto: UnsubscribeChatPushDto,
  ) {
    return this.push.unsubscribeAgent(request.salesAgent!.agentId, dto);
  }
}

import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ChatConversationStatus } from '../entities/chat-conversation.entity';
import { SalesAgentScope } from '../entities/sales-agent.entity';

export class SalesChatSupervisorQueryDto {
  @IsOptional()
  @IsEnum(SalesAgentScope)
  area?: SalesAgentScope;

  @IsOptional()
  @IsEnum(ChatConversationStatus)
  status?: ChatConversationStatus;

  @IsOptional()
  @IsUUID('4')
  agentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 30;
}

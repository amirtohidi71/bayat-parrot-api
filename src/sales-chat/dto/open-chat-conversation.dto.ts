import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ChatSourceType } from '../entities/chat-conversation.entity';
import { SalesAgentScope } from '../entities/sales-agent.entity';
import { IsInternalSalesChatSourcePath } from '../sales-chat-internal-path';

export class OpenChatConversationDto {
  @IsEnum(SalesAgentScope)
  area: SalesAgentScope;

  @IsOptional()
  @IsEnum(ChatSourceType)
  sourceType?: ChatSourceType;

  @IsOptional()
  @IsUUID('4')
  sourceProductId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @IsInternalSalesChatSourcePath()
  sourcePath?: string;
}

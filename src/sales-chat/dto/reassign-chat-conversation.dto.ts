import { IsUUID } from 'class-validator';

export class ReassignChatConversationDto {
  @IsUUID('4')
  agentId: string;
}

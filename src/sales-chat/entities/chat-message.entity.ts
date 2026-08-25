import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Product } from '../../products/entities/product.entity';
import { ChatConversation } from './chat-conversation.entity';
import { SalesAgent } from './sales-agent.entity';

export enum ChatMessageSenderType {
  CUSTOMER = 'CUSTOMER',
  AGENT = 'AGENT',
  SYSTEM = 'SYSTEM',
}

export enum ChatMessageType {
  TEXT = 'TEXT',
  CONTEXT = 'CONTEXT',
}

@Entity('chat_messages')
@Index(
  'UQ_chat_messages_conversation_sequence',
  ['conversationId', 'sequence'],
  {
    unique: true,
  },
)
@Index(
  'UQ_chat_messages_client_retry',
  ['conversationId', 'senderType', 'clientMessageId'],
  { unique: true },
)
@Index('IDX_chat_messages_conversation_poll', [
  'conversationId',
  'sequence',
  'id',
])
@Check(
  'CHK_chat_messages_payload',
  `("type" = 'TEXT' AND "text" IS NOT NULL AND char_length("text") BETWEEN 1 AND 4000
      AND "clientMessageId" IS NOT NULL AND "senderType" IN ('CUSTOMER', 'AGENT'))
   OR
   ("type" = 'CONTEXT' AND "text" IS NULL AND "clientMessageId" IS NULL
      AND "senderType" = 'SYSTEM')`,
)
@Check(
  'CHK_chat_messages_sender_identity',
  `("senderType" = 'CUSTOMER' AND "senderUserId" IS NOT NULL AND "senderAgentId" IS NULL)
   OR ("senderType" = 'AGENT' AND "senderUserId" IS NULL AND "senderAgentId" IS NOT NULL)
   OR ("senderType" = 'SYSTEM' AND "senderUserId" IS NULL AND "senderAgentId" IS NULL)`,
)
@Check('CHK_chat_messages_sequence', '"sequence" > 0')
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  conversationId: string;

  @ManyToOne(() => ChatConversation, (conversation) => conversation.messages, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation: ChatConversation;

  @Column({
    type: 'enum',
    enum: ChatMessageSenderType,
    enumName: 'chat_messages_sender_type_enum',
  })
  senderType: ChatMessageSenderType;

  @Column('uuid', { nullable: true })
  senderUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'senderUserId' })
  senderUser: User | null;

  @Column('uuid', { nullable: true })
  senderAgentId: string | null;

  @ManyToOne(() => SalesAgent, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'senderAgentId' })
  senderAgent: SalesAgent | null;

  @Column({
    type: 'enum',
    enum: ChatMessageType,
    enumName: 'chat_messages_type_enum',
  })
  type: ChatMessageType;

  @Column({ type: 'varchar', length: 4000, nullable: true })
  text: string | null;

  @Column({ type: 'integer' })
  sequence: number;

  @Column('uuid', { nullable: true })
  clientMessageId: string | null;

  @Column('uuid', { nullable: true })
  contextProductId: string | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'contextProductId' })
  contextProduct: Product | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  contextSourcePath: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

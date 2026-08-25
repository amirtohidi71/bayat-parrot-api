import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Product } from '../../products/entities/product.entity';
import { SalesAgent, SalesAgentScope } from './sales-agent.entity';
import { ChatMessage } from './chat-message.entity';
import { ConversationAssignment } from './conversation-assignment.entity';

export enum ChatConversationStatus {
  OPEN_UNASSIGNED = 'OPEN_UNASSIGNED',
  OPEN_ASSIGNED = 'OPEN_ASSIGNED',
  CLOSED = 'CLOSED',
}

export enum ChatChannel {
  WEB = 'WEB',
}

export enum ChatSourceType {
  PRODUCT_PAGE = 'PRODUCT_PAGE',
  ACCOUNT = 'ACCOUNT',
  FLOATING = 'FLOATING',
}

@Entity('chat_conversations')
@Index('UQ_chat_conversations_open_customer_area', ['customerUserId', 'area'], {
  unique: true,
  where: `"status" IN ('OPEN_UNASSIGNED', 'OPEN_ASSIGNED')`,
})
@Index('IDX_chat_conversations_customer_activity', [
  'customerUserId',
  'lastMessageAt',
  'id',
])
@Index('IDX_chat_conversations_agent_inbox', [
  'assignedAgentId',
  'status',
  'lastMessageAt',
  'id',
])
@Index('IDX_chat_conversations_queue', [
  'area',
  'status',
  'lastMessageAt',
  'id',
])
@Check(
  'CHK_chat_conversations_assignment_status',
  `("status" = 'OPEN_UNASSIGNED' AND "assignedAgentId" IS NULL) OR
   ("status" = 'OPEN_ASSIGNED' AND "assignedAgentId" IS NOT NULL) OR
   "status" = 'CLOSED'`,
)
@Check(
  'CHK_chat_conversations_sequences',
  '"lastSequence" >= 0 AND "customerLastReadSequence" >= 0 AND "agentLastReadSequence" >= 0 AND "customerLastReadSequence" <= "lastSequence" AND "agentLastReadSequence" <= "lastSequence"',
)
export class ChatConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  customerUserId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerUserId' })
  customer: User;

  @Column({
    type: 'enum',
    enum: SalesAgentScope,
    enumName: 'sales_agents_scope_enum',
  })
  area: SalesAgentScope;

  @Column({
    type: 'enum',
    enum: ChatConversationStatus,
    enumName: 'chat_conversations_status_enum',
  })
  status: ChatConversationStatus;

  @Column('uuid', { nullable: true })
  assignedAgentId: string | null;

  @ManyToOne(() => SalesAgent, (agent) => agent.assignedConversations, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'assignedAgentId' })
  assignedAgent: SalesAgent | null;

  @Column({
    type: 'enum',
    enum: ChatChannel,
    enumName: 'chat_conversations_channel_enum',
    default: ChatChannel.WEB,
  })
  channel: ChatChannel;

  @Column({
    type: 'enum',
    enum: ChatSourceType,
    enumName: 'chat_conversations_source_type_enum',
    nullable: true,
  })
  sourceType: ChatSourceType | null;

  @Column('uuid', { nullable: true })
  sourceProductId: string | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sourceProductId' })
  sourceProduct: Product | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  sourcePath: string | null;

  @Column({ type: 'integer', default: 0 })
  lastSequence: number;

  @Column({ type: 'integer', default: 0 })
  customerLastReadSequence: number;

  @Column({ type: 'integer', default: 0 })
  agentLastReadSequence: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  lastMessagePreview: string | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  lastMessageAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => ChatMessage, (message) => message.conversation)
  messages: ChatMessage[];

  @OneToMany(
    () => ConversationAssignment,
    (assignment) => assignment.conversation,
  )
  assignments: ConversationAssignment[];
}

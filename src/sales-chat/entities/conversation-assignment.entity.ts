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
import { ChatConversation } from './chat-conversation.entity';
import { SalesAgent } from './sales-agent.entity';

export enum ConversationAssignmentActorType {
  AGENT_CLAIM = 'AGENT_CLAIM',
  SUPERVISOR_REASSIGN = 'SUPERVISOR_REASSIGN',
}

@Entity('chat_conversation_assignments')
@Check(
  'CHK_chat_assignments_actor_identity',
  `("actorType" = 'AGENT_CLAIM' AND "actorAgentId" IS NOT NULL AND "actorAdminUsername" IS NULL)
   OR ("actorType" = 'SUPERVISOR_REASSIGN' AND "actorAgentId" IS NULL AND "actorAdminUsername" IS NOT NULL)`,
)
@Index('IDX_chat_assignments_conversation_time', [
  'conversationId',
  'createdAt',
  'id',
])
@Index('IDX_chat_assignments_agent_time', ['toAgentId', 'createdAt', 'id'])
export class ConversationAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  conversationId: string;

  @ManyToOne(
    () => ChatConversation,
    (conversation) => conversation.assignments,
    {
      nullable: false,
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'conversationId' })
  conversation: ChatConversation;

  @Column('uuid', { nullable: true })
  fromAgentId: string | null;

  @ManyToOne(() => SalesAgent, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'fromAgentId' })
  fromAgent: SalesAgent | null;

  @Column('uuid')
  toAgentId: string;

  @ManyToOne(() => SalesAgent, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'toAgentId' })
  toAgent: SalesAgent;

  @Column({
    type: 'enum',
    enum: ConversationAssignmentActorType,
    enumName: 'chat_assignment_actor_type_enum',
  })
  actorType: ConversationAssignmentActorType;

  @Column('uuid', { nullable: true })
  actorAgentId: string | null;

  @ManyToOne(() => SalesAgent, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actorAgentId' })
  actorAgent: SalesAgent | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  actorAdminUsername: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

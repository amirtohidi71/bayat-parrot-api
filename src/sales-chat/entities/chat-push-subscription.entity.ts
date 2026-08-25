import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { SalesAgent } from './sales-agent.entity';

export enum ChatPushOwnerType {
  CUSTOMER = 'CUSTOMER',
  SALES_AGENT = 'SALES_AGENT',
}

@Entity('chat_push_subscriptions')
@Index('UQ_chat_push_subscriptions_endpoint', ['endpoint'], { unique: true })
@Index('IDX_chat_push_subscriptions_customer', ['customerUserId'])
@Index('IDX_chat_push_subscriptions_agent', ['salesAgentId'])
@Check(
  'CHK_chat_push_subscriptions_owner',
  `("ownerType" = 'CUSTOMER' AND "customerUserId" IS NOT NULL AND "salesAgentId" IS NULL)
   OR
   ("ownerType" = 'SALES_AGENT' AND "salesAgentId" IS NOT NULL AND "customerUserId" IS NULL)`,
)
export class ChatPushSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: ChatPushOwnerType,
    enumName: 'chat_push_owner_type_enum',
  })
  ownerType: ChatPushOwnerType;

  @Column('uuid', { nullable: true })
  customerUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerUserId' })
  customer: User | null;

  @Column('uuid', { nullable: true })
  salesAgentId: string | null;

  @ManyToOne(() => SalesAgent, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'salesAgentId' })
  salesAgent: SalesAgent | null;

  @Column({ type: 'text' })
  endpoint: string;

  @Column({ type: 'text' })
  p256dh: string;

  @Column({ type: 'text' })
  auth: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

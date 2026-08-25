import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChatConversation } from './chat-conversation.entity';

export enum SalesAgentScope {
  PARROT = 'PARROT',
  PRODUCTS = 'PRODUCTS',
}

@Entity('sales_agents')
@Index('IDX_sales_agents_scope_active', ['scope', 'active', 'username'])
export class SalesAgent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  username: string;

  @Column({ type: 'varchar', length: 100 })
  displayName: string;

  @Column({
    type: 'enum',
    enum: SalesAgentScope,
    enumName: 'sales_agents_scope_enum',
  })
  scope: SalesAgentScope;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(
    () => ChatConversation,
    (conversation) => conversation.assignedAgent,
  )
  assignedConversations: ChatConversation[];
}

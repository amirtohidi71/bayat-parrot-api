import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BreederPermissionState } from './breeder-species-permission.entity';

export enum BreederPermissionAction {
  REQUEST = 'REQUEST',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  REVOKE = 'REVOKE',
  REGRANT = 'REGRANT',
}

@Entity({ name: 'breeder_permission_events', synchronize: false })
@Index(
  'UQ_breeder_event_species_revision',
  ['speciesPermissionId', 'revision'],
  { unique: true },
)
@Index(
  'UQ_breeder_event_subspecies_revision',
  ['subspeciesPermissionId', 'revision'],
  { unique: true },
)
@Index(
  'UQ_breeder_event_species_request',
  ['applicationId', 'requestId', 'speciesPermissionId'],
  { unique: true },
)
@Index(
  'UQ_breeder_event_subspecies_request',
  ['applicationId', 'requestId', 'subspeciesPermissionId'],
  { unique: true },
)
@Index('IDX_breeder_event_application_time', [
  'applicationId',
  'occurredAt',
  'id',
])
export class BreederPermissionEvent {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_breeder_permission_events',
  })
  id: string;

  @Column('uuid')
  applicationId: string;

  @Column({ type: 'uuid', nullable: true })
  speciesPermissionId: string | null;

  @Column({ type: 'uuid', nullable: true })
  subspeciesPermissionId: string | null;

  @Column('integer')
  revision: number;

  @Column({ type: 'varchar', length: 16 })
  action: BreederPermissionAction;

  @Column({ type: 'varchar', length: 16, nullable: true })
  fromState: BreederPermissionState | null;

  @Column({ type: 'varchar', length: 16 })
  toState: BreederPermissionState;

  @Column({ type: 'varchar', length: 8 })
  actorType: 'CUSTOMER' | 'ADMIN';

  @Column({ type: 'varchar', length: 100 })
  actorId: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column('uuid')
  requestId: string;

  @Column({ type: 'varchar', length: 64 })
  requestHash: string;

  @Column({ type: 'integer', default: 0 })
  affectedListingCount: number;

  @Column({ type: 'integer', default: 0 })
  affectedProductCount: number;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt: Date;
}

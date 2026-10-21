import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BreederPermissionState } from './breeder-species-permission.entity';

// Composite foreign keys and integrity triggers are SQL-managed.
@Entity({ name: 'breeder_subspecies_permissions', synchronize: false })
@Index(
  'UQ_breeder_subspecies_application_subspecies',
  ['applicationId', 'subspeciesId'],
  { unique: true },
)
@Index(
  'UQ_breeder_subspecies_listing_identity',
  ['id', 'applicationId', 'speciesId', 'subspeciesId'],
  { unique: true },
)
@Index('UQ_breeder_subspecies_event_identity', ['id', 'applicationId'], {
  unique: true,
})
@Index(
  'IDX_breeder_subspecies_application_state',
  ['applicationId', 'state'],
  {},
)
@Index(
  'IDX_breeder_subspecies_parent_state',
  ['speciesPermissionId', 'state'],
  {},
)
export class BreederSubspeciesPermission {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_breeder_subspecies_permissions',
  })
  id: string;

  @Column({ type: 'uuid' })
  applicationId: string;

  @Column({ type: 'uuid' })
  speciesId: string;

  @Column({ type: 'uuid' })
  subspeciesId: string;

  @Column({ type: 'uuid' })
  speciesPermissionId: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: BreederPermissionState.REQUESTED,
  })
  state: BreederPermissionState;

  @Column({ type: 'integer', default: 1 })
  revision: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

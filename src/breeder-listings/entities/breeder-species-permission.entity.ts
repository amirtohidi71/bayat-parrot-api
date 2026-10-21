import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BreederPermissionState {
  REQUESTED = 'REQUESTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  REVOKED = 'REVOKED',
}

// Composite foreign keys and integrity triggers are SQL-managed.
@Entity({ name: 'breeder_species_permissions', synchronize: false })
@Index(
  'UQ_breeder_species_application_species',
  ['applicationId', 'speciesId'],
  { unique: true },
)
@Index('UQ_breeder_species_identity', ['id', 'applicationId', 'speciesId'], {
  unique: true,
})
@Index('UQ_breeder_species_event_identity', ['id', 'applicationId'], {
  unique: true,
})
@Index('IDX_breeder_species_application_state', ['applicationId', 'state'], {})
export class BreederSpeciesPermission {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_breeder_species_permissions',
  })
  id: string;

  @Column({ type: 'uuid' })
  applicationId: string;

  @Column({ type: 'uuid' })
  speciesId: string;

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

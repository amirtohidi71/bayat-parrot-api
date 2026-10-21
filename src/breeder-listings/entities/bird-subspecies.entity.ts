import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Composite foreign keys and integrity triggers are SQL-managed.
@Entity({ name: 'bird_subspecies', synchronize: false })
@Index('UQ_bird_subspecies_species_key', ['speciesId', 'key'], { unique: true })
@Index('UQ_bird_subspecies_id_species', ['id', 'speciesId'], { unique: true })
export class BirdSubspecies {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_bird_subspecies',
  })
  id: string;

  @Column({ type: 'uuid' })
  speciesId: string;

  @Column({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'varchar', length: 100 })
  displayName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

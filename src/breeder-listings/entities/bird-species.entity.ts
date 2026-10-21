import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Composite foreign keys and integrity triggers are SQL-managed.
@Entity({ name: 'bird_species', synchronize: false })
@Index('UQ_bird_species_key', ['key'], { unique: true })
export class BirdSpecies {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_bird_species',
  })
  id: string;

  @Column({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'varchar', length: 100 })
  displayName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('otps')
export class Otp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  phone: string;

  @Column()
  codeHash: string;

  @Column()
  expiresAt: Date;

  @Column({ default: false })
  consumed: boolean;

  @CreateDateColumn()
  createdAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ProductStockReservationStatus {
  ACTIVE = 'ACTIVE',
  CONSUMED = 'CONSUMED',
  EXPIRED = 'EXPIRED',
  RELEASED = 'RELEASED',
}

@Entity({ name: 'product_stock_reservations', synchronize: false })
@Index('IDX_product_stock_reservations_product_active_expiry', [
  'productId',
  'status',
  'expiresAt',
])
@Index('IDX_product_stock_reservations_expiry_active', ['expiresAt'], {
  where: `"status" = 'ACTIVE'`,
})
@Index('IDX_product_stock_reservations_order', ['orderId', 'productId', 'id'])
@Index(
  'UQ_product_stock_reservations_user_key_product',
  ['userId', 'idempotencyKey', 'productId'],
  { unique: true },
)
export class ProductStockReservation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  productId: string;

  @Column('uuid')
  userId: string;

  @Column('uuid', { nullable: true })
  orderId: string | null;

  @Column({ type: 'integer' })
  quantity: number;

  @Column({ type: 'varchar', length: 128 })
  idempotencyKey: string;

  @Column({
    type: 'enum',
    enum: ProductStockReservationStatus,
    enumName: 'product_stock_reservations_status_enum',
    default: ProductStockReservationStatus.ACTIVE,
  })
  status: ProductStockReservationStatus;

  @Column({
    type: 'timestamptz',
    default: () => `CURRENT_TIMESTAMP + INTERVAL '15 minutes'`,
  })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

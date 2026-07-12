import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { Order } from './order.entity';

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  @Column()
  orderId: string;

  @ManyToOne(() => Product, { nullable: false })
  @JoinColumn({ name: 'productId' })
  product: Product;

  @Column()
  productId: string;

  @Column({ type: 'varchar', nullable: true })
  colorCode: string | null;

  @Column({ type: 'varchar', nullable: true })
  colorName: string | null;

  @Column()
  quantity: number;

  @Column('decimal', { precision: 15, scale: 2 })
  price: number;
}

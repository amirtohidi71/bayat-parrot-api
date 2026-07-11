import * as dotenv from 'dotenv';
import { DataSource, QueryRunner } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { OrderItem } from '../orders/entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { ProductReview } from '../products/entities/product-review.entity';
import { User } from '../users/entities/user.entity';

dotenv.config();

type CountRow = { count: string };

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function countRows(queryRunner: QueryRunner, tableName: 'orders' | 'order_items'): Promise<number> {
  const rows = await queryRunner.query(`SELECT COUNT(*)::text AS count FROM "${tableName}"`) as CountRow[];
  return Number(rows[0]?.count ?? 0);
}

async function main() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: getRequiredEnv('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    username: getRequiredEnv('DB_USERNAME'),
    password: process.env.DB_PASSWORD ?? '',
    database: getRequiredEnv('DB_NAME'),
    entities: [Order, OrderItem, Product, ProductReview, User],
    synchronize: false,
  });

  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();

  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    const ordersBefore = await countRows(queryRunner, 'orders');
    const orderItemsBefore = await countRows(queryRunner, 'order_items');

    console.log('Before cleanup:');
    console.log(`orders: ${ordersBefore}`);
    console.log(`order_items: ${orderItemsBefore}`);

    await queryRunner.query('DELETE FROM "order_items"');
    await queryRunner.query('DELETE FROM "orders"');

    const ordersAfter = await countRows(queryRunner, 'orders');
    const orderItemsAfter = await countRows(queryRunner, 'order_items');

    console.log('After cleanup:');
    console.log(`orders: ${ordersAfter}`);
    console.log(`order_items: ${orderItemsAfter}`);

    await queryRunner.commitTransaction();
    console.log('Cleanup committed successfully.');
  } catch (error) {
    await queryRunner.rollbackTransaction();
    console.error('Cleanup failed. Transaction rolled back.');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error('Cleanup failed before transaction completed.');
  console.error(error);
  process.exit(1);
});

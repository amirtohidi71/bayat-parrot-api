import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, QueryFailedError, Repository } from 'typeorm';
import moment = require('moment-jalaali');
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { ProductsService } from '../products/products.service';
import { UserRole } from '../users/entities/user.entity';
import { SmsService } from '../common/sms/sms.service';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const ORDER_NUMBER_PREFIX = 'BP';
const MAX_ORDER_NUMBER_ATTEMPTS = 5;

export interface SalesReportLine {
  productId: string;
  productName: string;
  quantitySold: number;
  revenue: number;
}

export interface SalesReport {
  totalOrders: number;
  totalRevenue: number;
  products: SalesReportLine[];
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private readonly ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemsRepository: Repository<OrderItem>,
    private readonly productsService: ProductsService,
    private readonly smsService: SmsService,
  ) {}

  async create(userId: string, phone: string, createOrderDto: CreateOrderDto): Promise<Order> {
    const lines: { productId: string; quantity: number; price: number }[] = [];
    let total = 0;

    for (const { productId, quantity } of createOrderDto.items) {
      const product = await this.productsService.findOne(productId);
      const price = Number(product.price);
      total += price * quantity;
      lines.push({ productId, quantity, price });
    }

    const order = await this.saveOrderWithOrderNumber(
      userId,
      total,
      createOrderDto.address,
      createOrderDto.postalCode,
    );

    const items = await this.orderItemsRepository.save(
      lines.map((line) => this.orderItemsRepository.create({ ...line, orderId: order.id })),
    );

    order.items = items;

    await this.smsService.send(
      phone,
      `سفارش شما با کد ${order.orderNumber} با موفقیت ثبت شد.`,
    );

    return order;
  }

  private async saveOrderWithOrderNumber(
    userId: string,
    total: number,
    address: string,
    postalCode: string,
  ): Promise<Order> {
    const datePrefix = `${ORDER_NUMBER_PREFIX}-${moment().format('jYYYYjMMjDD')}`;

    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
      const countToday = await this.ordersRepository.count({
        where: { orderNumber: Like(`${datePrefix}%`) },
      });
      const orderNumber = `${datePrefix}${(countToday + 1).toString().padStart(4, '0')}`;

      try {
        return await this.ordersRepository.save(
          this.ordersRepository.create({ userId, total, address, postalCode, orderNumber }),
        );
      } catch (error) {
        const isUniqueViolation =
          error instanceof QueryFailedError &&
          (error as unknown as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION;
        if (!isUniqueViolation || attempt === MAX_ORDER_NUMBER_ATTEMPTS) {
          throw error;
        }
        // Another concurrent order grabbed this number first; retry with a fresh count.
      }
    }

    throw new Error('Failed to generate a unique order number');
  }

  findAllByUser(userId: string): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { userId },
      relations: { items: { product: true } },
    });
  }

  findAllAdmin(): Promise<Order[]> {
    return this.ordersRepository.find({
      relations: { user: true, items: { product: true } },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string, requesterId: string, requesterRole: UserRole): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: { items: { product: true } },
    });
    if (!order) {
      throw new NotFoundException(`Order with id ${id} not found`);
    }
    if (requesterRole !== UserRole.ADMIN && order.userId !== requesterId) {
      throw new ForbiddenException('You cannot access this order');
    }
    return order;
  }

  async updateStatus(id: string, { status }: UpdateOrderStatusDto): Promise<Order> {
    const order = await this.ordersRepository.findOne({ where: { id } });
    if (!order) {
      throw new NotFoundException(`Order with id ${id} not found`);
    }
    order.status = status;
    return this.ordersRepository.save(order);
  }

  async getSalesReport(): Promise<SalesReport> {
    const totals = await this.ordersRepository
      .createQueryBuilder('order')
      .select('COUNT(order.id)', 'totalOrders')
      .addSelect('COALESCE(SUM(order.total), 0)', 'totalRevenue')
      .getRawOne<{ totalOrders: string; totalRevenue: string }>();

    const productLines = await this.orderItemsRepository
      .createQueryBuilder('item')
      .leftJoin('item.product', 'product')
      .select('product.id', 'productId')
      .addSelect('product.name', 'productName')
      .addSelect('SUM(item.quantity)', 'quantitySold')
      .addSelect('SUM(item.quantity * item.price)', 'revenue')
      .groupBy('product.id')
      .addGroupBy('product.name')
      .orderBy('revenue', 'DESC')
      .getRawMany<{ productId: string; productName: string; quantitySold: string; revenue: string }>();

    return {
      totalOrders: Number(totals?.totalOrders ?? 0),
      totalRevenue: Number(totals?.totalRevenue ?? 0),
      products: productLines.map((line) => ({
        productId: line.productId,
        productName: line.productName,
        quantitySold: Number(line.quantitySold),
        revenue: Number(line.revenue),
      })),
    };
  }
}

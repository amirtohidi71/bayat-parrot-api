import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Like, QueryFailedError, Repository } from 'typeorm';
import moment = require('moment-jalaali');
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { Product } from '../products/entities/product.entity';
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
    private readonly smsService: SmsService,
    private readonly dataSource: DataSource,
  ) {}

  async create(userId: string, phone: string, createOrderDto: CreateOrderDto): Promise<Order> {
    const order = await this.dataSource.transaction(async (manager) => {
      const productRepository = manager.getRepository(Product);
      const orderRepository = manager.getRepository(Order);
      const orderItemRepository = manager.getRepository(OrderItem);
      const lines: { productId: string; quantity: number; price: number }[] = [];
      let total = 0;

      for (const { productId, quantity } of createOrderDto.items) {
        const product = await productRepository
          .createQueryBuilder('product')
          .setLock('pessimistic_write')
          .where('product.id = :productId', { productId })
          .getOne();

        if (!product) {
          throw new NotFoundException(`Product with id ${productId} not found`);
        }
        if (quantity <= 0) {
          throw new BadRequestException('Order item quantity must be greater than zero');
        }
        if (product.stock < quantity) {
          throw new BadRequestException(`Insufficient stock for product ${product.name}`);
        }

        const price = Number(product.discountPrice ?? product.price);
        total += price * quantity;
        lines.push({ productId, quantity, price });
        product.stock -= quantity;
        await productRepository.save(product);
      }

      const savedOrder = await this.saveOrderWithOrderNumber(
        userId,
        total,
        createOrderDto.address,
        createOrderDto.postalCode,
        orderRepository,
      );

      const items = await orderItemRepository.save(
        lines.map((line) => orderItemRepository.create({ ...line, orderId: savedOrder.id })),
      );

      savedOrder.items = items;
      return savedOrder;
    });

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
    orderRepository = this.ordersRepository,
  ): Promise<Order> {
    const datePrefix = `${ORDER_NUMBER_PREFIX}-${moment().format('jYYYYjMMjDD')}`;

    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
      const countToday = await orderRepository.count({
        where: { orderNumber: Like(`${datePrefix}%`) },
      });
      const orderNumber = `${datePrefix}${(countToday + 1).toString().padStart(4, '0')}`;

      try {
        return await orderRepository.save(
          orderRepository.create({ userId, total, address, postalCode, orderNumber }),
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

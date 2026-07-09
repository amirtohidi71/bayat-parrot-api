import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Order, OrderStatus, PaymentStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { Product } from '../products/entities/product.entity';
import { UserRole } from '../users/entities/user.entity';
import { SmsService } from '../common/sms/sms.service';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const FIRST_ORDER_NUMBER = 87653221;
const LAST_EIGHT_DIGIT_ORDER_NUMBER = 99999999;
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

export type OrderDetailResponse = Order & {
  subtotal: number;
  discountTotal: number;
};

export interface AdminDashboardSummary {
  ordersToday: number;
  pendingOrders: number;
  todaySales: number;
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
      const lines: { productId: string; quantity: number; price: number; colorCode?: string | null; colorName?: string | null }[] = [];
      let total = 0;

      for (const { productId, sku, quantity, colorCode, colorName } of createOrderDto.items) {
        if (!productId && !sku) {
          throw new BadRequestException('Order item productId or sku is required');
        }

        const query = productRepository
          .createQueryBuilder('product')
          .setLock('pessimistic_write');
        if (productId) {
          query.where('product.id = :productId', { productId });
        } else {
          query.where('product.sku = :sku', { sku });
        }

        const product = await query.getOne();

        if (!product) {
          throw new NotFoundException(`Product with id or sku ${productId ?? sku} not found`);
        }
        if (quantity <= 0) {
          throw new BadRequestException('Order item quantity must be greater than zero');
        }

        const variants = Array.isArray(product.colorVariants) ? product.colorVariants : [];
        let selectedColorCode: string | null = colorCode ?? null;
        let selectedColorName: string | null = colorName ?? null;
        if (variants.length > 0) {
          if (!colorCode && !colorName) {
            throw new BadRequestException(`Color selection is required for product ${product.name}`);
          }
          const variantIndex = variants.findIndex((variant) => {
            const sameCode = colorCode && variant.colorCode === colorCode;
            const sameName = colorName && variant.colorName === colorName;
            return Boolean(sameCode || sameName);
          });
          if (variantIndex === -1) {
            throw new BadRequestException(`Selected color is not available for product ${product.name}`);
          }
          const variant = variants[variantIndex];
          if (variant.stock < quantity) {
            throw new BadRequestException(`Insufficient stock for color ${variant.colorName} of product ${product.name}`);
          }
          variants[variantIndex] = { ...variant, stock: variant.stock - quantity };
          product.colorVariants = variants;
          product.stock = variants.reduce((sum, item) => sum + Math.max(0, Number(item.stock) || 0), 0);
          selectedColorCode = variant.colorCode ?? null;
          selectedColorName = variant.colorName;
        } else {
          if (product.stock < quantity) {
            throw new BadRequestException(`Insufficient stock for product ${product.name}`);
          }
          product.stock -= quantity;
        }

        const price = Number(product.discountPrice ?? product.price);
        total += price * quantity;
        lines.push({ productId: product.id, quantity, price, colorCode: selectedColorCode, colorName: selectedColorName });
        await productRepository.save(product);
      }

      const savedOrder = await this.saveOrderWithOrderNumber(
        userId,
        total,
        createOrderDto.address,
        createOrderDto.postalCode,
        createOrderDto.recipientName,
        createOrderDto.recipientMobile,
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
    recipientName?: string,
    recipientMobile?: string,
    orderRepository = this.ordersRepository,
  ): Promise<Order> {
    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
      await orderRepository.query("SELECT pg_advisory_xact_lock(hashtext('orders_order_number'))");
      const orderNumber = await this.generateNextOrderNumber(orderRepository);

      try {
        return await orderRepository.save(
          orderRepository.create({
            userId,
            total,
            address,
            postalCode,
            recipientName: recipientName ?? null,
            recipientMobile: recipientMobile ?? null,
            orderNumber,
          }),
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

  private async generateNextOrderNumber(orderRepository: Repository<Order>): Promise<string> {
    const result = await orderRepository
      .createQueryBuilder('orders')
      .select('MAX(CAST(orders.orderNumber AS integer))', 'max')
      .where("orders.orderNumber ~ '^[0-9]{8}$'")
      .getRawOne<{ max: string | null }>();

    const nextOrderNumber = Math.max(Number(result?.max ?? 0) + 1, FIRST_ORDER_NUMBER);
    if (nextOrderNumber > LAST_EIGHT_DIGIT_ORDER_NUMBER) {
      throw new Error('No 8-digit order numbers are available');
    }

    return nextOrderNumber.toString().padStart(8, '0');
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

  async getAdminDashboardSummary(): Promise<AdminDashboardSummary> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

    const [ordersToday, pendingOrders, todaySalesRow] = await Promise.all([
      this.ordersRepository
        .createQueryBuilder('order')
        .where('order.createdAt >= :startOfToday', { startOfToday })
        .andWhere('order.createdAt < :startOfTomorrow', { startOfTomorrow })
        .getCount(),
      this.ordersRepository.count({ where: { status: OrderStatus.PENDING } }),
      this.ordersRepository
        .createQueryBuilder('order')
        .select('COALESCE(SUM(order.total), 0)', 'todaySales')
        .where('order.createdAt >= :startOfToday', { startOfToday })
        .andWhere('order.createdAt < :startOfTomorrow', { startOfTomorrow })
        .andWhere('(order.paymentStatus = :paid OR order.status = :completed)', {
          paid: PaymentStatus.SUCCESS,
          completed: OrderStatus.DELIVERED,
        })
        .getRawOne<{ todaySales: string }>(),
    ]);

    return {
      ordersToday,
      pendingOrders,
      todaySales: Number(todaySalesRow?.todaySales ?? 0),
    };
  }

  async findOne(id: string, requesterId: string, requesterRole: UserRole): Promise<OrderDetailResponse> {
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
    return Object.assign(order, this.calculateOrderTotals(order));
  }

  private calculateOrderTotals(order: Order): { subtotal: number; discountTotal: number } {
    const subtotal = (order.items ?? []).reduce((sum, item) => {
      const originalPrice = Number(item.product?.price ?? item.price);
      return sum + originalPrice * item.quantity;
    }, 0);
    const total = Number(order.total ?? 0);

    return {
      subtotal,
      discountTotal: Math.max(0, subtotal - total),
    };
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

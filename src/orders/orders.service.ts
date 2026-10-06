import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Order, OrderStatus, PaymentStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { UserRole } from '../users/entities/user.entity';
import { SmsService } from '../common/sms/sms.service';
import { getSmsErrorCode, maskPhone } from '../common/sms/sms.types';
import { StockReservationsService } from '../stock-reservations/stock-reservations.service';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const FIRST_ORDER_NUMBER = 87653221;
const LAST_EIGHT_DIGIT_ORDER_NUMBER = 99999999;
const MAX_ORDER_NUMBER_ATTEMPTS = 5;
export const PRODUCT_NOT_PUBLISHED_ERROR_CODE = 'ORDER_PRODUCT_NOT_PUBLISHED';
export const ORDER_RESERVATION_EXPIRED_ERROR_CODE =
  'ORDER_STOCK_RESERVATION_EXPIRED';
export const ORDER_PAYMENT_INVALID_STATE_ERROR_CODE =
  'ORDER_PAYMENT_INVALID_STATE';

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
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private readonly ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemsRepository: Repository<OrderItem>,
    private readonly smsService: SmsService,
    private readonly dataSource: DataSource,
    private readonly stockReservations: StockReservationsService,
  ) {}

  async create(
    userId: string,
    phone: string,
    createOrderDto: CreateOrderDto,
  ): Promise<Order> {
    const order = await this.dataSource.transaction(async (manager) => {
      const productRepository = manager.getRepository(Product);
      const orderRepository = manager.getRepository(Order);
      const orderItemRepository = manager.getRepository(OrderItem);
      const lines: {
        productId: string;
        quantity: number;
        price: number;
        colorCode?: string | null;
        colorName?: string | null;
      }[] = [];
      const sellerReservationItems: Array<{
        productId: string;
        quantity: number;
      }> = [];
      let total = 0;

      const resolvedItems = await Promise.all(
        createOrderDto.items.map(async (item, originalIndex) => {
          const { productId, sku } = item;
          if (!productId && !sku) {
            throw new BadRequestException(
              'Order item productId or sku is required',
            );
          }
          const query = productRepository
            .createQueryBuilder('product')
            .select(['product.id']);
          if (productId) query.where('product.id = :productId', { productId });
          else query.where('product.sku = :sku', { sku });
          const product = await query.getOne();
          if (!product) {
            throw new NotFoundException(
              `Product with id or sku ${productId ?? sku} not found`,
            );
          }
          return { item, originalIndex, resolvedProductId: product.id };
        }),
      );
      resolvedItems.sort((left, right) =>
        left.resolvedProductId < right.resolvedProductId
          ? -1
          : left.resolvedProductId > right.resolvedProductId
            ? 1
            : 0,
      );

      const orderedLines: Array<{
        originalIndex: number;
        line: {
          productId: string;
          quantity: number;
          price: number;
          colorCode?: string | null;
          colorName?: string | null;
        };
      }> = [];
      for (const { item, originalIndex, resolvedProductId } of resolvedItems) {
        const { quantity, colorCode, colorName } = item;
        const query = productRepository
          .createQueryBuilder('product')
          .select([
            'product.id',
            'product.sku',
            'product.name',
            'product.price',
            'product.discountPrice',
            'product.stock',
            'product.colorVariants',
            'product.status',
            'product.isSellerListing',
          ])
          .setLock('pessimistic_write')
          .where('product.id = :productId', { productId: resolvedProductId });

        const product = await query.getOne();

        if (!product) {
          throw new NotFoundException(
            `Product with id ${resolvedProductId} not found`,
          );
        }
        if (product.status !== ProductStatus.PUBLISHED) {
          throw new BadRequestException({
            statusCode: 400,
            code: PRODUCT_NOT_PUBLISHED_ERROR_CODE,
            message: 'Product is not available for purchase',
          });
        }
        if (quantity <= 0) {
          throw new BadRequestException(
            'Order item quantity must be greater than zero',
          );
        }

        const isSellerListing = product.isSellerListing === true;
        const variants = Array.isArray(product.colorVariants)
          ? product.colorVariants
          : [];
        let selectedColorCode: string | null = colorCode ?? null;
        let selectedColorName: string | null = colorName ?? null;
        if (variants.length > 0) {
          if (!colorCode && !colorName) {
            throw new BadRequestException(
              `Color selection is required for product ${product.name}`,
            );
          }
          const variantIndex = variants.findIndex((variant) => {
            const sameCode = colorCode && variant.colorCode === colorCode;
            const sameName = colorName && variant.colorName === colorName;
            return Boolean(sameCode || sameName);
          });
          if (variantIndex === -1) {
            throw new BadRequestException(
              `Selected color is not available for product ${product.name}`,
            );
          }
          const variant = variants[variantIndex];
          if (!isSellerListing && variant.stock < quantity) {
            throw new BadRequestException(
              `Insufficient stock for color ${variant.colorName} of product ${product.name}`,
            );
          }
          if (!isSellerListing) {
            variants[variantIndex] = {
              ...variant,
              stock: variant.stock - quantity,
            };
            product.colorVariants = variants;
            product.stock = variants.reduce(
              (sum, item) => sum + Math.max(0, Number(item.stock) || 0),
              0,
            );
          }
          selectedColorCode = variant.colorCode ?? null;
          selectedColorName = variant.colorName;
        } else {
          if (!isSellerListing && product.stock < quantity) {
            throw new BadRequestException(
              `Insufficient stock for product ${product.name}`,
            );
          }
          if (!isSellerListing) product.stock -= quantity;
        }

        const price = Number(product.discountPrice ?? product.price);
        total += price * quantity;
        orderedLines.push({
          originalIndex,
          line: {
            productId: product.id,
            quantity,
            price,
            colorCode: selectedColorCode,
            colorName: selectedColorName,
          },
        });
        if (isSellerListing)
          sellerReservationItems.push({ productId: product.id, quantity });
        else
          await productRepository.update(product.id, {
            stock: product.stock,
            colorVariants: product.colorVariants,
          });
      }
      lines.push(
        ...orderedLines
          .sort((left, right) => left.originalIndex - right.originalIndex)
          .map((value) => value.line),
      );

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
        lines.map((line) =>
          orderItemRepository.create({ ...line, orderId: savedOrder.id }),
        ),
      );

      if (sellerReservationItems.length > 0)
        await this.stockReservations.reserveInTransaction(
          manager,
          userId,
          `order:${savedOrder.id}`,
          sellerReservationItems,
          savedOrder.id,
        );

      savedOrder.items = items;
      return savedOrder;
    });

    try {
      await this.smsService.sendText(
        phone,
        `سفارش شما با کد ${order.orderNumber} با موفقیت ثبت شد.`,
      );
    } catch (error) {
      this.logger.warn(
        `SMS operation=order-created result=failed recipient=${maskPhone(phone)} code=${getSmsErrorCode(error)}`,
      );
    }

    return order;
  }

  async fulfillPaymentSuccess(id: string): Promise<Order> {
    const result = await this.dataSource.transaction(async (manager) => {
      const orders = manager.getRepository(Order);
      const order = await orders.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException(`Order with id ${id} not found`);
      if (order.paymentStatus === PaymentStatus.SUCCESS)
        return { order, expired: false };
      if (order.paymentStatus === PaymentStatus.FAILED)
        throw new ConflictException({
          statusCode: 409,
          code: ORDER_PAYMENT_INVALID_STATE_ERROR_CODE,
          message: 'Failed orders cannot be fulfilled',
        });
      const reservationResult =
        await this.stockReservations.consumeForOrderInTransaction(manager, id);
      if (reservationResult.expired) return { order, expired: true };
      order.paymentStatus = PaymentStatus.SUCCESS;
      order.paymentDate = new Date();
      return { order: await orders.save(order), expired: false };
    });
    if (result.expired)
      throw new ConflictException({
        statusCode: 409,
        code: ORDER_RESERVATION_EXPIRED_ERROR_CODE,
        message: 'Order stock reservation has expired',
      });
    return result.order;
  }

  async markPaymentFailed(id: string): Promise<Order> {
    return this.dataSource.transaction(async (manager) => {
      const orders = manager.getRepository(Order);
      const order = await orders.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException(`Order with id ${id} not found`);
      if (order.paymentStatus === PaymentStatus.SUCCESS)
        throw new ConflictException({
          statusCode: 409,
          code: ORDER_PAYMENT_INVALID_STATE_ERROR_CODE,
          message: 'Paid orders cannot be cancelled',
        });
      if (order.paymentStatus === PaymentStatus.FAILED) return order;
      await this.stockReservations.releaseForOrderInTransaction(manager, id);
      order.paymentStatus = PaymentStatus.FAILED;
      return orders.save(order);
    });
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
      await orderRepository.query(
        "SELECT pg_advisory_xact_lock(hashtext('orders_order_number'))",
      );
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
          (error as unknown as { code?: string }).code ===
            POSTGRES_UNIQUE_VIOLATION;
        if (!isUniqueViolation || attempt === MAX_ORDER_NUMBER_ATTEMPTS) {
          throw error;
        }
        // Another concurrent order grabbed this number first; retry with a fresh count.
      }
    }

    throw new Error('Failed to generate a unique order number');
  }

  private async generateNextOrderNumber(
    orderRepository: Repository<Order>,
  ): Promise<string> {
    const result = await orderRepository
      .createQueryBuilder('orders')
      .select('MAX(CAST(orders.orderNumber AS integer))', 'max')
      .where("orders.orderNumber ~ '^[0-9]{8}$'")
      .getRawOne<{ max: string | null }>();

    const nextOrderNumber = Math.max(
      Number(result?.max ?? 0) + 1,
      FIRST_ORDER_NUMBER,
    );
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
        .andWhere(
          '(order.paymentStatus = :paid OR order.status = :completed)',
          {
            paid: PaymentStatus.SUCCESS,
            completed: OrderStatus.DELIVERED,
          },
        )
        .getRawOne<{ todaySales: string }>(),
    ]);

    return {
      ordersToday,
      pendingOrders,
      todaySales: Number(todaySalesRow?.todaySales ?? 0),
    };
  }

  async findOne(
    id: string,
    requesterId: string,
    requesterRole: UserRole,
  ): Promise<OrderDetailResponse> {
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

  private calculateOrderTotals(order: Order): {
    subtotal: number;
    discountTotal: number;
  } {
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

  async updateStatus(
    id: string,
    { status }: UpdateOrderStatusDto,
  ): Promise<Order> {
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
      .getRawMany<{
        productId: string;
        productName: string;
        quantitySold: string;
        revenue: string;
      }>();

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

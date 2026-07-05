import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import moment = require('moment-jalaali');
import { OrdersService } from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import { ProductStatus } from '../products/entities/product.entity';
import { AdminLoginDto } from './dto/admin-login.dto';
import { CreateProductDto } from '../products/dto/create-product.dto';
import { UpdateProductDto } from '../products/dto/update-product.dto';
import { UpdateOrderStatusDto } from '../orders/dto/update-order-status.dto';
import { ADMIN_PANEL_SCOPE } from './guards/admin-auth.guard';

@Injectable()
export class AdminService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly ordersService: OrdersService,
    private readonly productsService: ProductsService,
  ) {}

  login({ username, password }: AdminLoginDto) {
    const adminUsers = (this.configService.get<string>('ADMIN_USERS') ?? '')
      .split(',')
      .map((adminUsername) => adminUsername.trim())
      .filter(Boolean);

    const canonicalUsername = adminUsers.find(
      (adminUsername) => adminUsername.toLowerCase() === username.toLowerCase(),
    );
    const expectedPassword = canonicalUsername
      ? this.configService.get<string>(`ADMIN_PASSWORD_${canonicalUsername.toUpperCase()}`)
      : undefined;

    if (!canonicalUsername || !expectedPassword || expectedPassword !== password) {
      throw new UnauthorizedException('Invalid username or password');
    }

    return {
      accessToken: this.jwtService.sign(
        { scope: ADMIN_PANEL_SCOPE, username: canonicalUsername },
        { expiresIn: '4h' },
      ),
      username: canonicalUsername,
    };
  }

  async getOrders() {
    const orders = await this.ordersService.findAllAdmin();
    return orders.map((order) => ({
      ...order,
      createdAtJalaali: moment(order.createdAt).format('jYYYY/jMM/jDD HH:mm'),
    }));
  }

  updateOrderStatus(id: string, updateOrderStatusDto: UpdateOrderStatusDto) {
    return this.ordersService.updateStatus(id, updateOrderStatusDto);
  }

  getSalesReport() {
    return this.ordersService.getSalesReport();
  }

  createProduct(createProductDto: CreateProductDto, adminName?: string) {
    return this.productsService.create({
      ...createProductDto,
      status: ProductStatus.PENDING,
      lastEditedByName: adminName ?? null,
    });
  }

  getProducts(status?: ProductStatus) {
    return this.productsService.findAllForAdmin(status);
  }

  getProduct(id: string) {
    return this.productsService.findOneForAdmin(id);
  }

  lookupProduct(identifier: string) {
    return this.productsService.findOneByIdOrSku(identifier);
  }

  getPendingProducts() {
    return this.productsService.findPending();
  }

  updateProduct(id: string, updateProductDto: UpdateProductDto, adminName?: string) {
    return this.productsService.update(id, {
      ...updateProductDto,
      lastEditedByName: adminName ?? null,
    });
  }

  removeProduct(id: string) {
    return this.productsService.remove(id);
  }

  uploadProductImage(id: string, file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No image file provided');
    }
    return this.productsService.addImage(id, `/uploads/${file.filename}`);
  }
}

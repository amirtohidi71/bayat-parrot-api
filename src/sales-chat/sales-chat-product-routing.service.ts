import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Product,
  ProductCategorySlug,
  ProductStatus,
} from '../products/entities/product.entity';
import { ChatSourceType } from './entities/chat-conversation.entity';
import { SalesAgentScope } from './entities/sales-agent.entity';
import { OpenChatConversationDto } from './dto/open-chat-conversation.dto';
import { canonicalProductSourcePath } from './sales-chat-internal-path';

export type ResolvedChatContext = {
  area: SalesAgentScope;
  sourceType: ChatSourceType | null;
  sourceProductId: string | null;
  sourcePath: string | null;
};

@Injectable()
export class SalesChatProductRoutingService {
  constructor(
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
  ) {}

  async resolve(dto: OpenChatConversationDto): Promise<ResolvedChatContext> {
    if (!dto.sourceProductId) {
      if (dto.sourceType === ChatSourceType.PRODUCT_PAGE) {
        throw new BadRequestException(
          'Product context requires sourceProductId',
        );
      }
      if (
        dto.sourceType === ChatSourceType.ACCOUNT &&
        dto.sourcePath &&
        !/^\/account(?:\/|$)/u.test(dto.sourcePath)
      ) {
        throw new BadRequestException(
          'Account context requires an account source path',
        );
      }
      return {
        area: dto.area,
        sourceType: dto.sourceType ?? null,
        sourceProductId: null,
        sourcePath:
          dto.sourcePath ??
          (dto.sourceType === ChatSourceType.ACCOUNT ? '/account' : null),
      };
    }

    if (dto.sourceType !== ChatSourceType.PRODUCT_PAGE) {
      throw new BadRequestException(
        'sourceType must be PRODUCT_PAGE for product context',
      );
    }
    const product = await this.products.findOne({
      where: { id: dto.sourceProductId, status: ProductStatus.PUBLISHED },
      select: { id: true, sku: true, name: true, categorySlug: true },
    });
    if (!product) throw new NotFoundException('Product context is unavailable');
    const authoritativeArea =
      product.categorySlug === ProductCategorySlug.BUY_PARROT
        ? SalesAgentScope.PARROT
        : SalesAgentScope.PRODUCTS;
    if (dto.area !== authoritativeArea) {
      throw new BadRequestException(
        'Product does not belong to the selected chat area',
      );
    }
    if (dto.sourcePath && !/^\/product(?:\/|$)/u.test(dto.sourcePath)) {
      throw new BadRequestException(
        'Product context requires a product source path',
      );
    }
    return {
      area: authoritativeArea,
      sourceType: ChatSourceType.PRODUCT_PAGE,
      sourceProductId: product.id,
      sourcePath: canonicalProductSourcePath(product),
    };
  }
}

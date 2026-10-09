import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { AdminTokenPayload } from '../admin/guards/admin-auth.guard';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import {
  ApproveParrotSaleListingDto,
  ListParrotSaleListingsDto,
  RejectParrotSaleListingDto,
} from './dto/parrot-sale-listing.dto';
import { ParrotSaleListingApprovalService } from './parrot-sale-listing-approval.service';
import {
  parrotSaleListingAdminResponse,
  parrotSaleListingApprovalResponse,
} from './parrot-sale-listing.responses';
import {
  parrotSaleListingPrivateImageResponse,
  PRIVATE_LISTING_IMAGE_CACHE_CONTROL,
} from './images/parrot-sale-listing-private-image.response';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

type AdminRequest = { admin: AdminTokenPayload };
const uuidPipe = new ParseUUIDPipe({ version: '4' });

@Controller('admin-panel/parrot-sale-listings')
@UseGuards(AdminAuthGuard)
export class AdminParrotSaleListingsController {
  constructor(
    private readonly listings: ParrotSaleListingsService,
    private readonly approval: ParrotSaleListingApprovalService,
  ) {}

  @Get()
  async list(@Query() query: ListParrotSaleListingsDto) {
    return (await this.listings.listForAdmin(query.status)).map(
      parrotSaleListingAdminResponse,
    );
  }

  @Get(':id')
  async detail(@Param('id', uuidPipe) id: string) {
    return parrotSaleListingAdminResponse(await this.listings.getForAdmin(id));
  }

  @Get(':id/images/:imageId/content')
  @Header('Cache-Control', PRIVATE_LISTING_IMAGE_CACHE_CONTROL)
  @Header('X-Content-Type-Options', 'nosniff')
  async readReviewImage(
    @Param('id', uuidPipe) id: string,
    @Param('imageId', uuidPipe) imageId: string,
  ): Promise<StreamableFile> {
    return parrotSaleListingPrivateImageResponse(
      await this.listings.readReviewImage(id, imageId),
    );
  }

  @Post(':id/reject')
  async reject(
    @Param('id', uuidPipe) id: string,
    @Body() input: RejectParrotSaleListingDto,
    @Req() request: AdminRequest,
  ) {
    return parrotSaleListingAdminResponse(
      await this.listings.reject(id, request.admin.username, input),
    );
  }

  @Post(':id/approve')
  async approve(
    @Param('id', uuidPipe) id: string,
    @Body() input: ApproveParrotSaleListingDto,
    @Req() request: AdminRequest,
  ) {
    return parrotSaleListingApprovalResponse(
      await this.approval.approve(id, request.admin.username, input),
    );
  }
}

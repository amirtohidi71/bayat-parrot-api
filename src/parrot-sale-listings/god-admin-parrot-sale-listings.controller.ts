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
import type { GodAdminTokenPayload } from '../admin/guards/god-admin-auth.guard';
import { GodAdminAuthGuard } from '../admin/guards/god-admin-auth.guard';
import {
  ApproveParrotSaleListingDto,
  ListParrotSaleListingsDto,
} from './dto/parrot-sale-listing.dto';
import { ParrotSaleListingStatus } from './entities/parrot-sale-listing.entity';
import { ParrotSaleListingApprovalService } from './parrot-sale-listing-approval.service';
import {
  parrotSaleListingApprovalResponse,
  parrotSaleListingGodAdminDetailResponse,
  parrotSaleListingGodAdminSummaryResponse,
} from './parrot-sale-listing.responses';
import {
  parrotSaleListingPrivateImageResponse,
  PRIVATE_LISTING_IMAGE_CACHE_CONTROL,
} from './images/parrot-sale-listing-private-image.response';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

type GodAdminRequest = { godAdmin: GodAdminTokenPayload };
const uuidPipe = new ParseUUIDPipe({ version: '4' });

@Controller('god-admin-panel/parrot-sale-listings')
@UseGuards(GodAdminAuthGuard)
export class GodAdminParrotSaleListingsController {
  constructor(
    private readonly approval: ParrotSaleListingApprovalService,
    private readonly listings: ParrotSaleListingsService,
  ) {}

  @Get()
  async list(@Query() query: ListParrotSaleListingsDto) {
    return (
      await this.listings.listForGodAdmin(
        query.status ?? ParrotSaleListingStatus.PENDING_REVIEW,
      )
    ).map(parrotSaleListingGodAdminSummaryResponse);
  }

  @Get(':id')
  async detail(@Param('id', uuidPipe) id: string) {
    return parrotSaleListingGodAdminDetailResponse(
      await this.listings.getForGodAdmin(id),
    );
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

  @Post(':id/approve')
  async approve(
    @Param('id', uuidPipe) id: string,
    @Body() input: ApproveParrotSaleListingDto,
    @Req() request: GodAdminRequest,
  ) {
    const result = await this.approval.approve(
      id,
      request.godAdmin.username,
      input,
    );
    return parrotSaleListingApprovalResponse(result);
  }
}

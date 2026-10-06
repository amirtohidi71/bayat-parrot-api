import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { CustomerCapabilityGuard } from '../auth/guards/customer-capability.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CreateParrotSaleListingDto,
  UpdateParrotSaleListingDto,
} from './dto/parrot-sale-listing.dto';
import { parrotSaleListingImageUploadOptions } from './images/parrot-sale-listing-image-upload.config';
import {
  parrotSaleListingPrivateImageResponse,
  PRIVATE_LISTING_IMAGE_CACHE_CONTROL,
} from './images/parrot-sale-listing-private-image.response';
import { ParrotSaleListingErrorCode } from './parrot-sale-listing.errors';
import { parrotSaleListingSellerResponse } from './parrot-sale-listing.responses';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

const uuidPipe = new ParseUUIDPipe({ version: '4' });

@Controller('parrot-sale-listings')
@UseGuards(JwtAuthGuard, CustomerCapabilityGuard)
export class ParrotSaleListingsController {
  constructor(private readonly listings: ParrotSaleListingsService) {}

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateParrotSaleListingDto,
  ) {
    return parrotSaleListingSellerResponse(
      await this.listings.create(user.id, input),
    );
  }

  @Get()
  async listOwn(@CurrentUser() user: AuthenticatedUser) {
    return (await this.listings.listOwn(user.id)).map(
      parrotSaleListingSellerResponse,
    );
  }

  @Get(':id')
  async getOwn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuidPipe) id: string,
  ) {
    return parrotSaleListingSellerResponse(
      await this.listings.getOwn(user.id, id),
    );
  }

  @Get(':id/images/:imageId/content')
  @Header('Cache-Control', PRIVATE_LISTING_IMAGE_CACHE_CONTROL)
  @Header('X-Content-Type-Options', 'nosniff')
  async readOwnImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuidPipe) id: string,
    @Param('imageId', uuidPipe) imageId: string,
  ): Promise<StreamableFile> {
    return parrotSaleListingPrivateImageResponse(
      await this.listings.readOwnImage(user.id, id, imageId),
    );
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuidPipe) id: string,
    @Body() input: UpdateParrotSaleListingDto,
  ) {
    return parrotSaleListingSellerResponse(
      await this.listings.update(user.id, id, input),
    );
  }

  @Post(':id/images')
  @UseInterceptors(
    FileInterceptor('image', parrotSaleListingImageUploadOptions),
  )
  async addImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuidPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file?.buffer)
      throw new BadRequestException({
        statusCode: 400,
        code: ParrotSaleListingErrorCode.IMAGE_REQUIRED,
        message: 'Parrot sale listing image is required',
      });
    return parrotSaleListingSellerResponse(
      await this.listings.addImage(user.id, id, file.buffer, file.mimetype),
    );
  }

  @Delete(':id/images/:imageId')
  async deleteImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuidPipe) id: string,
    @Param('imageId', uuidPipe) imageId: string,
  ) {
    return parrotSaleListingSellerResponse(
      await this.listings.deleteImage(user.id, id, imageId),
    );
  }

  @Post(':id/submit')
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuidPipe) id: string,
  ) {
    return parrotSaleListingSellerResponse(
      await this.listings.submit(user.id, id),
    );
  }
}

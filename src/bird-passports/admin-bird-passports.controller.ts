import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import {
  feedingResponse,
  toAdminPassportDetail,
  toAdminPassportSummary,
  vaccineResponse,
  veterinaryResponse,
} from './admin-bird-passport-response';
import { BirdPassportsService } from './bird-passports.service';
import { AdminListBirdPassportsDto } from './dto/admin-list-bird-passports.dto';
import { CreateBirdPassportDto } from './dto/create-bird-passport.dto';
import { CreateFeedingRecordDto } from './dto/create-feeding-record.dto';
import { CreateVaccineRecordDto } from './dto/create-vaccine-record.dto';
import { CreateVeterinaryVisitDto } from './dto/create-veterinary-visit.dto';
import { UpdateBirdPassportDto } from './dto/update-bird-passport.dto';
import { UpdateFeedingRecordDto } from './dto/update-feeding-record.dto';
import { UpdateVaccineRecordDto } from './dto/update-vaccine-record.dto';
import { UpdateVeterinaryVisitDto } from './dto/update-veterinary-visit.dto';
import { BirdPassportImagesService } from './images/bird-passport-images.service';
import { BIRD_PASSPORT_IMAGE_MAX_BYTES } from './images/bird-passport-image.types';
import { AdminBirdPassportNoStoreInterceptor } from './admin-bird-passport-no-store.interceptor';
import { BirdPassportTaxonomyService } from './bird-passport-taxonomy.service';

const uuidPipe = new ParseUUIDPipe({ version: '4' });

@Controller('admin-panel/bird-passports')
@UseGuards(AdminAuthGuard)
@UseInterceptors(AdminBirdPassportNoStoreInterceptor)
export class AdminBirdPassportsController {
  constructor(
    private readonly passports: BirdPassportsService,
    private readonly images: BirdPassportImagesService,
    private readonly taxonomyService: BirdPassportTaxonomyService,
  ) {}

  @Post()
  async create(@Body() dto: CreateBirdPassportDto) {
    return toAdminPassportSummary(await this.passports.create(dto));
  }

  @Get()
  async list(@Query() query: AdminListBirdPassportsDto) {
    const result = await this.passports.listPassportsAdmin(query);
    return { ...result, items: result.items.map(toAdminPassportSummary) };
  }

  @Get('taxonomy')
  taxonomy() {
    return this.taxonomyService.list();
  }

  @Get(':id')
  async detail(@Param('id', uuidPipe) id: string) {
    return toAdminPassportDetail(await this.passports.getById(id));
  }

  @Patch(':id')
  async update(
    @Param('id', uuidPipe) id: string,
    @Body() dto: UpdateBirdPassportDto,
  ) {
    return toAdminPassportSummary(await this.passports.updatePassport(id, dto));
  }

  @Post(':id/activate')
  async activate(@Param('id', uuidPipe) id: string) {
    return toAdminPassportSummary(await this.passports.activatePassport(id));
  }

  @Post(':id/archive')
  async archive(@Param('id', uuidPipe) id: string) {
    return toAdminPassportSummary(await this.passports.archivePassport(id));
  }

  @Put(':id/image')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: BIRD_PASSPORT_IMAGE_MAX_BYTES },
    }),
  )
  async replaceImage(
    @Param('id', uuidPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file?.buffer)
      throw new BadRequestException('Bird passport image is required');
    return toAdminPassportSummary(
      await this.images.replaceImage(id, file.buffer, file.mimetype),
    );
  }

  @Get(':id/image')
  async readImage(
    @Param('id', uuidPipe) id: string,
    @Res() response: Response,
  ) {
    const image = await this.images.readImage(id);
    response.set({
      'Content-Type': image.mimeType,
      'Content-Length': String(image.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(image.buffer);
  }

  @Post(':passportId/vaccines')
  async addVaccine(
    @Param('passportId', uuidPipe) passportId: string,
    @Body() dto: CreateVaccineRecordDto,
  ) {
    return vaccineResponse(await this.passports.addVaccine(passportId, dto));
  }

  @Patch(':passportId/vaccines/:recordId')
  async updateVaccine(
    @Param('passportId', uuidPipe) passportId: string,
    @Param('recordId', uuidPipe) recordId: string,
    @Body() dto: UpdateVaccineRecordDto,
  ) {
    return vaccineResponse(
      await this.passports.updateVaccine(passportId, recordId, dto),
    );
  }

  @Delete(':passportId/vaccines/:recordId')
  deleteVaccine(
    @Param('passportId', uuidPipe) passportId: string,
    @Param('recordId', uuidPipe) recordId: string,
  ) {
    return this.passports.deleteVaccine(passportId, recordId);
  }

  @Post(':passportId/feedings')
  async addFeeding(
    @Param('passportId', uuidPipe) passportId: string,
    @Body() dto: CreateFeedingRecordDto,
  ) {
    return feedingResponse(await this.passports.addFeeding(passportId, dto));
  }

  @Patch(':passportId/feedings/:recordId')
  async updateFeeding(
    @Param('passportId', uuidPipe) passportId: string,
    @Param('recordId', uuidPipe) recordId: string,
    @Body() dto: UpdateFeedingRecordDto,
  ) {
    return feedingResponse(
      await this.passports.updateFeeding(passportId, recordId, dto),
    );
  }

  @Delete(':passportId/feedings/:recordId')
  deleteFeeding(
    @Param('passportId', uuidPipe) passportId: string,
    @Param('recordId', uuidPipe) recordId: string,
  ) {
    return this.passports.deleteFeeding(passportId, recordId);
  }

  @Post(':passportId/veterinary-visits')
  async addVeterinaryVisit(
    @Param('passportId', uuidPipe) passportId: string,
    @Body() dto: CreateVeterinaryVisitDto,
  ) {
    return veterinaryResponse(
      await this.passports.addVeterinaryVisit(passportId, dto),
    );
  }

  @Patch(':passportId/veterinary-visits/:recordId')
  async updateVeterinaryVisit(
    @Param('passportId', uuidPipe) passportId: string,
    @Param('recordId', uuidPipe) recordId: string,
    @Body() dto: UpdateVeterinaryVisitDto,
  ) {
    return veterinaryResponse(
      await this.passports.updateVeterinaryVisit(passportId, recordId, dto),
    );
  }

  @Delete(':passportId/veterinary-visits/:recordId')
  deleteVeterinaryVisit(
    @Param('passportId', uuidPipe) passportId: string,
    @Param('recordId', uuidPipe) recordId: string,
  ) {
    return this.passports.deleteVeterinaryVisit(passportId, recordId);
  }
}

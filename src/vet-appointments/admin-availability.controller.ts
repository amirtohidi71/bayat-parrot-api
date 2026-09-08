import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import type { AdminTokenPayload } from '../admin/guards/admin-auth.guard';
import { VetAvailabilityService } from './availability.service';
import {
  AvailabilityGeometryDto,
  CreateAvailabilityDto,
  ListAvailabilityDto,
} from './dto/availability-request.dto';

@Controller('admin/vet/availability-windows')
@UseGuards(AdminAuthGuard)
export class AdminVetAvailabilityController {
  constructor(private readonly availability: VetAvailabilityService) {}

  @Post()
  create(
    @Body() input: CreateAvailabilityDto,
    @Req() request: { admin: AdminTokenPayload },
  ) {
    return this.availability.create(input, request.admin.username);
  }

  @Get()
  list(@Query() query: ListAvailabilityDto) {
    return this.availability.list(query);
  }

  @Get(':id')
  read(@Param('id', ParseUUIDPipe) id: string) {
    return this.availability.read(id);
  }

  @Get(':id/slots')
  slots(@Param('id', ParseUUIDPipe) id: string) {
    return this.availability.slots(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.availability.cancel(id);
  }

  @Post(':id/retire')
  @HttpCode(200)
  retire(@Param('id', ParseUUIDPipe) id: string) {
    return this.availability.retire(id);
  }

  @Post(':id/replace')
  replace(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: AvailabilityGeometryDto,
    @Req() request: { admin: AdminTokenPayload },
  ) {
    return this.availability.replace(id, input, request.admin.username);
  }
}

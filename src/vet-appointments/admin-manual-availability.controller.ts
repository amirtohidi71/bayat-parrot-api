import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import type { AdminTokenPayload } from '../admin/guards/admin-auth.guard';
import { VetAvailabilityService } from './availability.service';
import { CreateManualAvailabilitySlotsDto } from './dto/manual-availability-slot.dto';

@Controller('admin/vet/availability-slots')
@UseGuards(AdminAuthGuard)
export class AdminVetManualAvailabilityController {
  constructor(private readonly availability: VetAvailabilityService) {}

  @Post('manual')
  create(
    @Body() input: CreateManualAvailabilitySlotsDto,
    @Req() request: { admin: AdminTokenPayload },
  ) {
    return this.availability.createManualSlots(input, request.admin.username);
  }
}

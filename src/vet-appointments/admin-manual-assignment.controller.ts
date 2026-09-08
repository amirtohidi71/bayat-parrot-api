import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import type { AdminTokenPayload } from '../admin/guards/admin-auth.guard';
import { AdminManualVetAssignmentDto } from './dto/admin-manual-assignment.dto';
import { VetManualAssignmentService } from './vet-manual-assignment.service';

@Controller('admin/vet/appointments')
@UseGuards(AdminAuthGuard)
export class AdminVetManualAssignmentController {
  constructor(private readonly assignments: VetManualAssignmentService) {}

  @Post('manual')
  create(
    @Body() input: AdminManualVetAssignmentDto,
    @Req() request: { admin: AdminTokenPayload },
  ) {
    return this.assignments.create(input, request.admin.username);
  }
}

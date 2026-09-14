import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import {
  CreateAdminVetDoctorDto,
  UpdateAdminVetDoctorDto,
} from './dto/admin-vet-doctor.dto';
import { VetDoctorDirectoryService } from './vet-doctor-directory.service';

@Controller('admin/vet/doctors')
@UseGuards(AdminAuthGuard)
export class AdminVetDoctorsController {
  constructor(private readonly doctors: VetDoctorDirectoryService) {}

  @Get()
  list() {
    return this.doctors.list();
  }

  @Post()
  create(@Body() input: CreateAdminVetDoctorDto) {
    return this.doctors.create(input);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateAdminVetDoctorDto,
  ) {
    return this.doctors.update(id, input);
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.doctors.activate(id);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.doctors.deactivate(id);
  }
}

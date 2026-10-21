import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CustomerCapabilityGuard } from '../auth/guards/customer-capability.guard';
import { RequestBreederTaxaDto } from './breeder-taxon.dto';
import { BreederTaxonService } from './breeder-taxon.service';

@Controller('seller-onboarding')
@UseGuards(JwtAuthGuard, CustomerCapabilityGuard)
export class BreederTaxonController {
  constructor(private readonly taxa: BreederTaxonService) {}

  @Get('taxonomy')
  taxonomy() {
    return this.taxa.taxonomy();
  }

  @Get('breeder-applications/:id/permissions')
  permissions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taxa.read(id, user.id);
  }

  @Post('breeder-applications/:id/taxon-requests')
  request(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: RequestBreederTaxaDto,
  ) {
    return this.taxa.request(id, user.id, input);
  }
}

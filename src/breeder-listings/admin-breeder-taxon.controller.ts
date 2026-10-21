import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import type { AdminTokenPayload } from '../admin/guards/admin-auth.guard';
import {
  BreederPermissionDecision,
  BreederPermissionKind,
  DecideBreederPermissionDto,
} from './breeder-taxon.dto';
import { BreederTaxonService } from './breeder-taxon.service';

@Controller('admin-panel/seller-onboarding')
@UseGuards(AdminAuthGuard)
export class AdminBreederTaxonController {
  constructor(private readonly taxa: BreederTaxonService) {}

  @Get('taxonomy')
  taxonomy() {
    return this.taxa.taxonomy();
  }

  @Get('breeder-applications/:id/permissions')
  permissions(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taxa.read(id);
  }

  @Post('breeder-applications/:id/:kind/:permissionId/:action')
  decide(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('kind', new ParseEnumPipe(BreederPermissionKind))
    kind: BreederPermissionKind,
    @Param('permissionId', new ParseUUIDPipe()) permissionId: string,
    @Param('action', new ParseEnumPipe(BreederPermissionDecision))
    action: BreederPermissionDecision,
    @Req() request: { admin: AdminTokenPayload },
    @Body() input: DecideBreederPermissionDto,
  ) {
    return this.taxa.decide(
      id,
      permissionId,
      kind,
      action,
      request.admin.username,
      input,
    );
  }
}

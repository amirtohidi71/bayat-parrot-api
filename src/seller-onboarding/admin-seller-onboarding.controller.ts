import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AdminTokenPayload } from '../admin/guards/admin-auth.guard';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import {
  AdminBreederCallDto,
  AdminNoteDto,
  AdminRejectDto,
  AdminRevokeSellerAccessDto,
  ListBreederApplicationsDto,
  ListSellerVerificationsDto,
} from './dto/seller-onboarding.dto';
import { SellerOnboardingService } from './seller-onboarding.service';
import {
  breederAdminResponse,
  sellerAdminResponse,
} from './seller-onboarding.responses';

type AdminRequest = { admin: AdminTokenPayload };

@Controller('admin-panel/seller-onboarding')
@UseGuards(AdminAuthGuard)
export class AdminSellerOnboardingController {
  constructor(private readonly onboarding: SellerOnboardingService) {}

  @Get('verifications')
  async listVerifications(@Query() query: ListSellerVerificationsDto) {
    return (await this.onboarding.listSellers(query.status)).map(
      sellerAdminResponse,
    );
  }

  @Get('verifications/:id')
  async verification(@Param('id', new ParseUUIDPipe()) id: string) {
    return sellerAdminResponse(await this.onboarding.sellerDetail(id));
  }

  @Post('verifications/:id/approve')
  async approveVerification(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminNoteDto,
    @Req() request: AdminRequest,
  ) {
    return sellerAdminResponse(
      await this.onboarding.approveSeller(id, request.admin.username, input),
    );
  }

  @Post('verifications/:id/reject')
  async rejectVerification(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminRejectDto,
    @Req() request: AdminRequest,
  ) {
    return sellerAdminResponse(
      await this.onboarding.rejectSeller(id, request.admin.username, input),
    );
  }

  @Post('verifications/:id/revoke')
  async revokeVerification(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminRevokeSellerAccessDto,
    @Req() request: AdminRequest,
  ) {
    return sellerAdminResponse(
      await this.onboarding.revokeSellerAccess(
        id,
        request.admin.username,
        input,
      ),
    );
  }

  @Get('breeder-applications')
  async listBreeders(@Query() query: ListBreederApplicationsDto) {
    return (await this.onboarding.listBreeders(query.status)).map(
      breederAdminResponse,
    );
  }

  @Get('breeder-applications/:id')
  async breeder(@Param('id', new ParseUUIDPipe()) id: string) {
    return breederAdminResponse(await this.onboarding.breederDetail(id));
  }

  @Post('breeder-applications/:id/contact')
  async contact(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminBreederCallDto,
    @Req() request: AdminRequest,
  ) {
    return breederAdminResponse(
      await this.onboarding.recordBreederCall(
        id,
        request.admin.username,
        input,
      ),
    );
  }

  @Post('breeder-applications/:id/approve')
  async approveBreeder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AdminRequest,
  ) {
    return breederAdminResponse(
      await this.onboarding.approveBreeder(id, request.admin.username),
    );
  }

  @Post('breeder-applications/:id/reject')
  async rejectBreeder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AdminRejectDto,
    @Req() request: AdminRequest,
  ) {
    return breederAdminResponse(
      await this.onboarding.rejectBreeder(id, request.admin.username, input),
    );
  }
}

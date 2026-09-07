import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import {
  toOwnUserProfileResponse,
  toUserDirectoryResponse,
} from './dto/user-response.dto';
import { UserDirectoryAdminGuard } from './guards/user-directory-admin.guard';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @Header('Cache-Control', 'private, no-store')
  async getProfile(@CurrentUser() user: AuthenticatedUser) {
    return toOwnUserProfileResponse(await this.usersService.findOne(user.id));
  }

  @Patch('profile')
  @Header('Cache-Control', 'private, no-store')
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    return toOwnUserProfileResponse(
      await this.usersService.updateProfile(user.id, updateProfileDto),
    );
  }

  @Get('loyalty-points')
  async getLoyaltyPoints(@CurrentUser() user: AuthenticatedUser) {
    const { loyaltyPoints } = await this.usersService.findOne(user.id);
    return { loyaltyPoints };
  }

  @Get()
  @UseGuards(UserDirectoryAdminGuard)
  @Header('Cache-Control', 'private, no-store')
  async findAll() {
    return (await this.usersService.findAll()).map(toUserDirectoryResponse);
  }

  @Get(':id')
  @UseGuards(UserDirectoryAdminGuard)
  @Header('Cache-Control', 'private, no-store')
  async findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return toUserDirectoryResponse(await this.usersService.findOne(id));
  }
}

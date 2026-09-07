import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { UserDirectoryAdminGuard } from './guards/user-directory-admin.guard';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService, UserDirectoryAdminGuard],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}

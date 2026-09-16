import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { UsersService } from '../users/users.service';

@Controller('admin/vet/customers')
@UseGuards(AdminAuthGuard)
export class AdminVetCustomerDirectoryController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async listCustomers() {
    const customers = await this.users.findCustomersForAdminVetAssignment();
    return customers.map((customer) => ({
      id: customer.id,
      phone: customer.phone,
      firstName: customer.firstName ?? null,
      lastName: customer.lastName ?? null,
      email: customer.email ?? null,
      profileCompleted: customer.profileCompleted,
      role: customer.role,
    }));
  }
}

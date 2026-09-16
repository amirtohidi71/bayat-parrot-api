import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { User, UserRole } from './entities/user.entity';
import { UsersService } from './users.service';

describe('UsersService admin vet customer directory', () => {
  it('queries only customer users with the manual-assignment allowlist', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: { find } },
      ],
    }).compile();

    await moduleRef.get(UsersService).findCustomersForAdminVetAssignment();

    expect(find).toHaveBeenCalledWith({
      where: { role: UserRole.CUSTOMER },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        email: true,
        profileCompleted: true,
        role: true,
      },
    });
  });
});

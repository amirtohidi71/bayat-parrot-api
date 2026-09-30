import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { FindOperator } from 'typeorm';
import { User, UserRole } from './entities/user.entity';
import { UsersService } from './users.service';

type CustomerDirectoryFindOptions = {
  where: { role: FindOperator<UserRole> };
  select: Record<string, boolean>;
};

describe('UsersService admin vet customer directory', () => {
  it('queries customer and breeder users with the same safe allowlist', async () => {
    const find = jest
      .fn<Promise<User[]>, [CustomerDirectoryFindOptions]>()
      .mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: { find } },
      ],
    }).compile();

    await moduleRef.get(UsersService).findCustomersForAdminVetAssignment();

    const query = find.mock.calls[0][0];
    expect(query.where.role).toBeInstanceOf(FindOperator);
    expect(query.where.role.value).toEqual([
      UserRole.CUSTOMER,
      UserRole.BREEDER,
    ]);
    expect(query.select).toEqual({
      id: true,
      phone: true,
      firstName: true,
      lastName: true,
      email: true,
      profileCompleted: true,
      role: true,
    });
  });
});

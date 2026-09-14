import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { VetDoctor } from './entities/doctor.entity';
import { VetDoctorDirectoryService } from './vet-doctor-directory.service';

describe('VetDoctorDirectoryService', () => {
  const id = randomUUID();
  const existing = (): VetDoctor => ({
    id,
    displayName: 'دکتر الف',
    mobile: '09120000000',
    username: 'Doctor_One',
    passwordHash:
      '$2b$10$PKiS5pw/tWYFhlcMa9TaI.RdZRtUeNJuuNSutT32NjRRq/Zc8N4zC',
    active: true,
    consultationFeeMinor: '100000',
    currency: 'IRR',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  let repository: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let service: VetDoctorDirectoryService;
  let createdRecord: VetDoctor | undefined;
  let savedRecord: VetDoctor | undefined;

  beforeEach(() => {
    createdRecord = undefined;
    savedRecord = undefined;
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((value: VetDoctor) => {
        createdRecord = value;
        return value;
      }),
      save: jest.fn((value: VetDoctor) => {
        savedRecord = value;
        return Promise.resolve({ id, ...value });
      }),
    };
    service = new VetDoctorDirectoryService(
      repository as unknown as Repository<VetDoctor>,
    );
  });

  it('lists active and inactive doctors ordered by display name with an allowlisted response', async () => {
    repository.find.mockResolvedValue([
      { ...existing(), passwordHash: 'hidden', createdAt: new Date() },
      { ...existing(), id: randomUUID(), displayName: 'دکتر ب', active: false },
    ]);
    const result = await service.list();
    expect(repository.find).toHaveBeenCalledWith({
      select: {
        id: true,
        displayName: true,
        mobile: true,
        username: true,
        active: true,
        consultationFeeMinor: true,
        currency: true,
      },
      order: { displayName: 'ASC' },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id,
      displayName: 'دکتر الف',
      mobile: '09120000000',
      username: 'Doctor_One',
      active: true,
      consultationFeeMinor: '100000',
      currency: 'IRR',
    });
    expect(result[0]).not.toHaveProperty('passwordHash');
    expect(result[0]).not.toHaveProperty('createdAt');
  });

  it('creates a doctor with a cost-10 bcrypt hash and never returns it', async () => {
    const result = await service.create({
      displayName: 'دکتر جدید',
      mobile: '09121111111',
      username: 'Doctor_New',
      password: 'secure-password',
      consultationFeeMinor: '250000',
      currency: 'IRR',
      active: false,
    });
    const created = createdRecord!;
    expect(created.passwordHash).not.toBe('secure-password');
    await expect(
      bcrypt.compare('secure-password', created.passwordHash),
    ).resolves.toBe(true);
    expect(bcrypt.getRounds(created.passwordHash)).toBe(10);
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).toMatchObject({ active: false, username: 'Doctor_New' });
  });

  it.each([
    [
      'username',
      'UQ_vet_doctors_username_ci',
      'Vet doctor username already exists',
    ],
    ['mobile', 'UQ_vet_doctors_mobile', 'Vet doctor mobile already exists'],
  ])(
    'maps duplicate %s to stable conflict',
    async (_field, constraint, message) => {
      repository.save.mockRejectedValueOnce(uniqueError(constraint));
      await expect(
        service.create({
          displayName: 'دکتر جدید',
          mobile: '09121111111',
          username: 'Doctor_New',
          password: 'secure-password',
          consultationFeeMinor: '0',
          currency: 'IRR',
        }),
      ).rejects.toMatchObject({ status: 409, message });
    },
  );

  it.each([
    [
      { username: 'Existing_User' },
      'UQ_vet_doctors_username_ci',
      'Vet doctor username already exists',
    ],
    [
      { mobile: '09129999999' },
      'UQ_vet_doctors_mobile',
      'Vet doctor mobile already exists',
    ],
  ])(
    'maps conflicting partial updates to stable conflict',
    async (change, constraint, message) => {
      repository.findOne.mockResolvedValue(existing());
      repository.save.mockRejectedValueOnce(uniqueError(constraint));
      await expect(service.update(id, change)).rejects.toMatchObject({
        status: 409,
        message,
      });
    },
  );

  it('updates only supplied fields', async () => {
    repository.findOne.mockResolvedValue(existing());
    const result = await service.update(id, {
      displayName: 'دکتر ویرایش‌شده',
      consultationFeeMinor: '300000',
    });
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        displayName: 'دکتر ویرایش‌شده',
        mobile: '09120000000',
        username: 'Doctor_One',
        consultationFeeMinor: '300000',
      }),
    );
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('hashes an optional password update', async () => {
    repository.findOne.mockResolvedValue(existing());
    await service.update(id, { password: 'replacement-password' });
    const saved = savedRecord!;
    await expect(
      bcrypt.compare('replacement-password', saved.passwordHash),
    ).resolves.toBe(true);
    expect(bcrypt.getRounds(saved.passwordHash)).toBe(10);
  });

  it('activates and deactivates by updating the same record without deleting history', async () => {
    repository.findOne.mockResolvedValueOnce(existing());
    await expect(service.deactivate(id)).resolves.toMatchObject({
      active: false,
    });
    expect(repository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ id, active: false }),
    );
    repository.findOne.mockResolvedValueOnce({ ...existing(), active: false });
    await expect(service.activate(id)).resolves.toMatchObject({ active: true });
    expect(repository).not.toHaveProperty('delete');
    expect(repository).not.toHaveProperty('remove');
  });

  it('returns 404 for an unknown doctor and 400 for an empty update', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(
      service.update(id, { displayName: 'دکتر' }),
    ).rejects.toMatchObject({
      status: 404,
      message: 'Vet doctor not found',
    });
    await expect(service.update(id, {})).rejects.toMatchObject({ status: 400 });
  });
});

function uniqueError(constraint: string) {
  return new QueryFailedError('INSERT INTO vet_doctors', [], {
    code: '23505',
    constraint,
  });
}

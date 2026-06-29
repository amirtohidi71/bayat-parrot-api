import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  async findOne(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }
    return user;
  }

  findByPhone(phone: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { phone } });
  }

  createWithPhone(phone: string): Promise<User> {
    const user = this.usersRepository.create({ phone });
    return this.usersRepository.save(user);
  }

  async updateProfile(id: string, updateProfileDto: UpdateProfileDto): Promise<User> {
    const user = await this.findOne(id);
    Object.assign(user, updateProfileDto);
    return this.usersRepository.save(user);
  }

  async completeRegistration(id: string, firstName: string, lastName: string): Promise<User> {
    const user = await this.findOne(id);
    user.firstName = firstName;
    user.lastName = lastName;
    user.profileCompleted = true;
    return this.usersRepository.save(user);
  }
}

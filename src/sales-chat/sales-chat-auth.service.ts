import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { SalesAgentLoginDto } from './dto/sales-agent-login.dto';
import { SalesAgent } from './entities/sales-agent.entity';
import {
  SALES_CHAT_AGENT_JWT,
  SALES_CHAT_AGENT_SCOPE,
} from './sales-chat.constants';

@Injectable()
export class SalesChatAuthService {
  constructor(
    @InjectRepository(SalesAgent)
    private readonly agents: Repository<SalesAgent>,
    private readonly config: ConfigService,
    @Inject(SALES_CHAT_AGENT_JWT) private readonly jwt: JwtService,
  ) {}

  async login({ username, password }: SalesAgentLoginDto) {
    const canonicalUsername = username.trim().toLowerCase();
    const agent = await this.agents
      .createQueryBuilder('agent')
      .where('lower(agent.username) = :username', {
        username: canonicalUsername,
      })
      .getOne();
    const expectedPassword = agent
      ? this.config.get<string>(
          `SALES_AGENT_PASSWORD_${agent.username.toUpperCase()}`,
        )
      : undefined;

    if (!agent?.active || !expectedPassword || expectedPassword !== password) {
      throw new UnauthorizedException('Invalid username or password');
    }

    return {
      accessToken: this.jwt.sign({
        sub: agent.id,
        agentId: agent.id,
        username: agent.username,
        agentScope: agent.scope,
        scope: SALES_CHAT_AGENT_SCOPE,
        role: 'sales-agent',
      }),
      agent: {
        id: agent.id,
        username: agent.username,
        displayName: agent.displayName,
        scope: agent.scope,
      },
    };
  }
}

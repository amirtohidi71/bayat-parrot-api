import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SalesAgent, SalesAgentScope } from '../entities/sales-agent.entity';
import {
  SALES_CHAT_AGENT_JWT,
  SALES_CHAT_AGENT_SCOPE,
} from '../sales-chat.constants';

export type SalesAgentTokenPayload = {
  sub: string;
  agentId: string;
  username: string;
  agentScope: SalesAgentScope;
  scope: typeof SALES_CHAT_AGENT_SCOPE;
  role: 'sales-agent';
};

export type SalesAgentRequest = {
  salesAgent?: SalesAgentTokenPayload;
  headers: { authorization?: string };
};

@Injectable()
export class SalesAgentAuthGuard implements CanActivate {
  constructor(
    @Inject(SALES_CHAT_AGENT_JWT) private readonly jwt: JwtService,
    @InjectRepository(SalesAgent)
    private readonly agents: Repository<SalesAgent>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SalesAgentRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing sales token');

    try {
      const payload = this.jwt.verify<SalesAgentTokenPayload>(token);
      if (
        payload.scope !== SALES_CHAT_AGENT_SCOPE ||
        payload.role !== 'sales-agent' ||
        payload.sub !== payload.agentId ||
        !Object.values(SalesAgentScope).includes(payload.agentScope)
      ) {
        throw new Error('invalid');
      }
      const agent = await this.agents.findOne({
        where: {
          id: payload.agentId,
          username: payload.username,
          scope: payload.agentScope,
          active: true,
        },
        select: { id: true },
      });
      if (!agent) throw new Error('inactive');
      request.salesAgent = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired sales token');
    }
  }
}

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Supertest exposes its HTTP server and response body through any-typed boundaries. */
import {
  Global,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { OrdersService } from '../orders/orders.service';
import { ProductReviewVideosService } from '../products/product-review-videos.service';
import { ProductsService } from '../products/products.service';
import { ChatPushService } from './chat-push.service';
import { SalesAgent, SalesAgentScope } from './entities/sales-agent.entity';
import { SalesChatModule } from './sales-chat.module';
import { SalesChatService } from './sales-chat.service';

const USER_ADMIN_SECRET = 'sales-chat-user-admin-test-secret-1234567890';
const SALES_SECRET = 'sales-chat-agent-test-secret-123456789012345';
const ADMIN_PASSWORD = 'admin-test-password';
const AGENT_PASSWORD = 'agent-test-password';

const agentRows = Array.from({ length: 6 }, (_, index) => ({
  id: `3000000${index + 1}-0000-4000-8000-00000000000${index + 1}`,
  username: `ad${index + 1}`,
  displayName: `Ad${index + 1}`,
  scope: index < 4 ? SalesAgentScope.PARROT : SalesAgentScope.PRODUCTS,
  active: true,
})) as SalesAgent[];

let queriedUsername = '';
const salesAgentRepository = {
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn((_sql: string, params: { username: string }) => {
      queriedUsername = params.username;
      return {
        getOne: () =>
          Promise.resolve(
            agentRows.find((agent) => agent.username === queriedUsername) ??
              null,
          ),
      };
    }),
  })),
  findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
    Promise.resolve(
      agentRows.find(
        (agent) =>
          (!where.id || agent.id === where.id) &&
          (!where.username || agent.username === where.username) &&
          (!where.scope || agent.scope === where.scope) &&
          (where.active === undefined || agent.active === where.active),
      ) ?? null,
    ),
  ),
};

const genericRepository = {
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  create: jest.fn((value) => value),
  save: jest.fn((value) => Promise.resolve(value)),
};

const fakeDataSource = {
  entityMetadatas: [],
  options: { type: 'postgres' },
  getRepository: jest.fn((entity: unknown) =>
    entity === SalesAgent ? salesAgentRepository : genericRepository,
  ),
};

@Global()
@Module({
  providers: [{ provide: getDataSourceToken(), useValue: fakeDataSource }],
  exports: [getDataSourceToken()],
})
class SalesChatFakeDatabaseModule {}

describe('Sales Chat runtime JWT and supervisor wiring', () => {
  let app: INestApplication;
  const chat = {
    listAgentQueue: jest.fn().mockResolvedValue({ items: [] }),
    listAgentConversations: jest.fn().mockResolvedValue({ items: [] }),
    getAgentUnreadCount: jest.fn().mockResolvedValue({ unreadCount: 0 }),
    listCustomerConversations: jest.fn().mockResolvedValue({ items: [] }),
    getCustomerUnreadCount: jest.fn().mockResolvedValue({ unreadCount: 0 }),
    getCustomerMessages: jest.fn().mockResolvedValue({ items: [] }),
    getAgentMessages: jest.fn().mockResolvedValue({ items: [] }),
    getSupervisorMessages: jest.fn().mockResolvedValue({ items: [] }),
    listSupervisorConversations: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 30,
    }),
    listActiveAgents: jest.fn().mockResolvedValue({ items: [] }),
  };
  const push = {
    getPublicConfig: jest.fn(() => ({ enabled: false, vapidPublicKey: null })),
  };

  beforeAll(async () => {
    const admins = ['pahlevan', 'bayat', 'shoaei', 'ahmadi', 'shayan'];
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'test',
              JWT_SECRET: USER_ADMIN_SECRET,
              SALES_CHAT_JWT_SECRET: SALES_SECRET,
              SALES_CHAT_SUPERVISORS: 'pahlevan,bayat,shoaei',
              ADMIN_USERS: admins.join(','),
              ...Object.fromEntries(
                admins.map((username) => [
                  `ADMIN_PASSWORD_${username.toUpperCase()}`,
                  ADMIN_PASSWORD,
                ]),
              ),
              ...Object.fromEntries(
                agentRows.map((agent) => [
                  `SALES_AGENT_PASSWORD_${agent.username.toUpperCase()}`,
                  AGENT_PASSWORD,
                ]),
              ),
              SMS_ENABLED: 'false',
              CHAT_PUSH_ENABLED: 'false',
            }),
          ],
        }),
        SalesChatFakeDatabaseModule,
        AuthModule,
        AdminModule,
        SalesChatModule,
      ],
    })
      .overrideProvider(OrdersService)
      .useValue({})
      .overrideProvider(ProductsService)
      .useValue({})
      .overrideProvider(ProductReviewVideosService)
      .useValue({})
      .overrideProvider(SalesChatService)
      .useValue(chat)
      .overrideProvider(ChatPushService)
      .useValue(push)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  it.each(agentRows)(
    'logs in $displayName with stable $scope identity',
    async (agent) => {
      const response = await request(app.getHttpServer())
        .post('/sales-chat/agent/login')
        .send({ username: agent.displayName, password: AGENT_PASSWORD })
        .expect(201);
      expect(response.body.agent).toEqual({
        id: agent.id,
        username: agent.username,
        displayName: agent.displayName,
        scope: agent.scope,
      });
      await request(app.getHttpServer())
        .get('/sales-chat/agent/queue')
        .set('Authorization', `Bearer ${response.body.accessToken}`)
        .expect(200);
    },
  );

  it('returns the same generic failure for invalid sales credentials', async () => {
    await request(app.getHttpServer())
      .post('/sales-chat/agent/login')
      .send({ username: 'Ad1', password: 'wrong' })
      .expect(401)
      .expect(({ body }) => {
        expect(body.message).toBe('Invalid username or password');
      });
  });

  it.each(['pahlevan', 'bayat', 'shoaei'])(
    'allows supervisor %s through real Admin login and guards',
    async (username) => {
      const token = await adminLogin(username);
      await request(app.getHttpServer())
        .get('/admin-panel/sales-chat/conversations')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    },
  );

  it.each(['ahmadi', 'shayan'])(
    'allows normal Admin login but denies Chat access for %s',
    async (username) => {
      const token = await adminLogin(username);
      await request(app.getHttpServer())
        .get('/admin-panel/sales-chat/conversations')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    },
  );

  it('keeps customer, Admin, God Admin and Sales tokens isolated', async () => {
    const userJwt = new JwtService({ secret: USER_ADMIN_SECRET });
    const customerToken = userJwt.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      phone: '09123456789',
      role: 'customer',
    });
    const adminToken = await adminLogin('pahlevan');
    const godToken = userJwt.sign({
      scope: 'god-admin-panel',
      role: 'owner',
      username: 'owner',
    });
    const salesLogin = await request(app.getHttpServer())
      .post('/sales-chat/agent/login')
      .send({ username: 'Ad1', password: AGENT_PASSWORD })
      .expect(201);
    const salesToken = salesLogin.body.accessToken as string;

    for (const token of [customerToken, adminToken, godToken]) {
      await request(app.getHttpServer())
        .get('/sales-chat/agent/queue')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
    await request(app.getHttpServer())
      .get('/sales-chat/customer/conversations')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/sales-chat/customer/conversations')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/admin-panel/sales-chat/conversations')
      .set('Authorization', `Bearer ${godToken}`)
      .expect(401);
  });

  it('rejects an expired, correctly signed Sales token', async () => {
    const agent = agentRows[0];
    const token = new JwtService({ secret: SALES_SECRET }).sign(
      {
        sub: agent.id,
        agentId: agent.id,
        username: agent.username,
        agentScope: agent.scope,
        scope: 'sales-chat-agent',
        role: 'sales-agent',
      },
      { expiresIn: -1 },
    );
    await request(app.getHttpServer())
      .get('/sales-chat/agent/queue')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects malformed UUID route parameters before customer, agent, or supervisor service access', async () => {
    const userJwt = new JwtService({ secret: USER_ADMIN_SECRET });
    const customerToken = userJwt.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      phone: '09123456789',
      role: 'customer',
    });
    const salesLogin = await request(app.getHttpServer())
      .post('/sales-chat/agent/login')
      .send({ username: 'Ad1', password: AGENT_PASSWORD })
      .expect(201);
    const supervisorToken = await adminLogin('pahlevan');

    await request(app.getHttpServer())
      .get('/sales-chat/customer/conversations/not-a-uuid/messages')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/sales-chat/agent/conversations/not-a-uuid/messages')
      .set('Authorization', `Bearer ${salesLogin.body.accessToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/admin-panel/sales-chat/conversations/not-a-uuid/messages')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .expect(400);

    expect(chat.getCustomerMessages).not.toHaveBeenCalled();
    expect(chat.getAgentMessages).not.toHaveBeenCalled();
    expect(chat.getSupervisorMessages).not.toHaveBeenCalled();
  });

  async function adminLogin(username: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/admin-panel/login')
      .send({ username, password: ADMIN_PASSWORD })
      .expect(201);
    return response.body.accessToken as string;
  }
});

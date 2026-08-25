import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { ProductReview } from '../products/entities/product-review.entity';
import { ProductReviewVideo } from '../products/entities/product-review-video.entity';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import {
  ChatSourceType,
  ChatConversation,
} from './entities/chat-conversation.entity';
import { ChatMessage, ChatMessageType } from './entities/chat-message.entity';
import { ChatPushSubscription } from './entities/chat-push-subscription.entity';
import { ConversationAssignment } from './entities/conversation-assignment.entity';
import { SalesAgent, SalesAgentScope } from './entities/sales-agent.entity';
import { SalesChatService } from './sales-chat.service';

const enabled =
  process.env.SALES_CHAT_RUN_DB_TESTS === '1' &&
  process.env.SALES_CHAT_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;

const USER_1 = '11111111-1111-4111-8111-111111111111';
const USER_2 = '22222222-2222-4222-8222-222222222222';
const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describeDatabase('Sales Chat PostgreSQL integration', () => {
  let dataSource: DataSource;
  let service: SalesChatService;
  let migrationSql: string;
  let resolvedProduct = PRODUCT_A;
  const routing = {
    resolve: jest.fn(
      (dto: { area: SalesAgentScope; sourceProductId?: string }) =>
        Promise.resolve({
          area: dto.area,
          sourceType: ChatSourceType.PRODUCT_PAGE,
          sourceProductId: dto.sourceProductId ?? resolvedProduct,
          sourcePath: `/product/${dto.sourceProductId ?? resolvedProduct}`,
        }),
    ),
  };
  const push = {
    notifyAssignedAgent: jest.fn().mockResolvedValue(undefined),
    notifyAreaAgents: jest.fn().mockResolvedValue(undefined),
    notifyCustomer: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: requireDisposableDatabaseUrl(),
      entities: [
        User,
        Product,
        ProductReview,
        ProductReviewVideo,
        SalesAgent,
        ChatConversation,
        ChatMessage,
        ConversationAssignment,
        ChatPushSubscription,
      ],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    const [identity] = await dataSource.query<
      Array<{ database: string; server: string }>
    >(
      'SELECT current_database() AS database, inet_server_addr()::text AS server',
    );
    if (!identity?.database || !/(test|disposable)/i.test(identity.database)) {
      throw new Error(
        'Refusing to use a database not named as test/disposable',
      );
    }

    await resetDisposableSchema();
    migrationSql = (
      await readFile(
        resolve(
          process.cwd(),
          'scripts',
          'migrations',
          '20260819-create-sales-chat-v1.sql',
        ),
        'utf8',
      )
    ).replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
    await dataSource.query(migrationSql);
    await dataSource.query(migrationSql);
    await dataSource.query(
      `INSERT INTO public.users
         (id, phone, "profileCompleted", "loyaltyPoints", role)
       VALUES ($1, '09111111111', true, 0, 'customer'),
              ($2, '09222222222', true, 0, 'customer')`,
      [USER_1, USER_2],
    );
    await dataSource.query(
      'INSERT INTO public.products (id) VALUES ($1), ($2)',
      [PRODUCT_A, PRODUCT_B],
    );

    service = new SalesChatService(
      dataSource.getRepository(ChatConversation),
      dataSource.getRepository(ChatMessage),
      dataSource.getRepository(SalesAgent),
      dataSource,
      routing as never,
      push as never,
    );
  }, 60_000);

  beforeEach(async () => {
    resolvedProduct = PRODUCT_A;
    jest.clearAllMocks();
    await dataSource.query(
      'TRUNCATE public.chat_push_subscriptions, public.chat_conversation_assignments, public.chat_messages, public.chat_conversations CASCADE',
    );
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dropSalesChatObjects();
    await dataSource.query('DROP TABLE IF EXISTS public.products CASCADE');
    await dataSource.query('DROP TABLE IF EXISTS public.users CASCADE');
    await dataSource.destroy();
  });

  it('runs twice and seeds stable Ad1-Ad6 scope identities', async () => {
    const rows = await dataSource.query<
      Array<{ username: string; scope: string; active: boolean }>
    >(
      'SELECT username, scope::text, active FROM public.sales_agents ORDER BY username',
    );
    expect(rows).toEqual([
      { username: 'ad1', scope: 'PARROT', active: true },
      { username: 'ad2', scope: 'PARROT', active: true },
      { username: 'ad3', scope: 'PARROT', active: true },
      { username: 'ad4', scope: 'PARROT', active: true },
      { username: 'ad5', scope: 'PRODUCTS', active: true },
      { username: 'ad6', scope: 'PRODUCTS', active: true },
    ]);
  });

  it('enforces one open conversation per customer and area and preserves context history', async () => {
    const first = await service.openCustomerConversation(USER_1, {
      area: SalesAgentScope.PARROT,
      sourceType: ChatSourceType.PRODUCT_PAGE,
      sourceProductId: PRODUCT_A,
    });
    const repeated = await service.openCustomerConversation(USER_1, {
      area: SalesAgentScope.PARROT,
      sourceType: ChatSourceType.PRODUCT_PAGE,
      sourceProductId: PRODUCT_A,
    });
    const changed = await service.openCustomerConversation(USER_1, {
      area: SalesAgentScope.PARROT,
      sourceType: ChatSourceType.PRODUCT_PAGE,
      sourceProductId: PRODUCT_B,
    });
    const products = await service.openCustomerConversation(USER_1, {
      area: SalesAgentScope.PRODUCTS,
      sourceType: ChatSourceType.PRODUCT_PAGE,
      sourceProductId: PRODUCT_B,
    });
    expect(repeated.id).toBe(first.id);
    expect(changed.id).toBe(first.id);
    expect(products.id).not.toBe(first.id);
    const contexts = await dataSource.getRepository(ChatMessage).find({
      where: { conversationId: first.id, type: ChatMessageType.CONTEXT },
      order: { sequence: 'ASC' },
    });
    expect(contexts.map((message) => message.contextProductId)).toEqual([
      PRODUCT_A,
      PRODUCT_B,
    ]);
  });

  it('returns one deterministic open conversation under concurrent creation', async () => {
    const [first, second] = await Promise.all([
      service.openCustomerConversation(USER_1, {
        area: SalesAgentScope.PARROT,
      }),
      service.openCustomerConversation(USER_1, {
        area: SalesAgentScope.PARROT,
      }),
    ]);
    expect(second.id).toBe(first.id);
    expect(
      await dataSource.getRepository(ChatConversation).count({
        where: { customerUserId: USER_1, area: SalesAgentScope.PARROT },
      }),
    ).toBe(1);
  });

  it('allows exactly one concurrent claimant and rejects wrong-scope access', async () => {
    const conversation = await service.openCustomerConversation(USER_1, {
      area: SalesAgentScope.PARROT,
    });
    const [ad1, ad2, ad5] = await Promise.all([
      agent('ad1'),
      agent('ad2'),
      agent('ad5'),
    ]);
    const attempts = await Promise.allSettled([
      service.claimConversation(ad1.id, ad1.scope, conversation.id),
      service.claimConversation(ad2.id, ad2.scope, conversation.id),
    ]);
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = attempts.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
    await expect(
      service.claimConversation(ad5.id, ad5.scope, conversation.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      await dataSource.getRepository(ConversationAssignment).count({
        where: { conversationId: conversation.id },
      }),
    ).toBe(1);
  });

  it('keeps TEXT ordering/idempotency, ownership, unread and assignment history intact', async () => {
    const conversation = await service.openCustomerConversation(USER_1, {
      area: SalesAgentScope.PARROT,
    });
    const ad1 = await agent('ad1');
    const ad2 = await agent('ad2');
    await service.claimConversation(ad1.id, ad1.scope, conversation.id);

    const messageId = '90000001-0000-4000-8000-000000000001';
    const first = await service.sendCustomerMessage(USER_1, conversation.id, {
      clientMessageId: messageId,
      text: 'سلام 🦜',
    });
    const duplicate = await service.sendCustomerMessage(
      USER_1,
      conversation.id,
      {
        clientMessageId: messageId,
        text: 'متن retry نادیده گرفته می‌شود',
      },
    );
    expect(duplicate.item.id).toBe(first.item.id);
    expect(duplicate.duplicate).toBe(true);
    await service.sendAgentMessage(ad1.id, ad1.scope, conversation.id, {
      clientMessageId: '90000002-0000-4000-8000-000000000002',
      text: 'پاسخ مشاور',
    });
    const page = await service.getCustomerMessages(USER_1, conversation.id, {
      afterSequence: 0,
      limit: 50,
    });
    expect(page.items.map((message) => message.sequence)).toEqual([1, 2, 3]);
    expect(page.items.map((message) => message.type)).toEqual([
      ChatMessageType.CONTEXT,
      ChatMessageType.TEXT,
      ChatMessageType.TEXT,
    ]);
    await expect(
      service.getCustomerMessages(USER_2, conversation.id, {
        afterSequence: 0,
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.sendCustomerMessage(USER_2, conversation.id, {
        clientMessageId: '90000003-0000-4000-8000-000000000003',
        text: 'cross-customer write',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.markCustomerRead(USER_2, conversation.id, { sequence: 3 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(
      await service.markAgentRead(ad1.id, ad1.scope, conversation.id, {
        sequence: 2,
      }),
    ).toMatchObject({ readThroughSequence: 2 });
    expect(
      await service.markAgentRead(ad1.id, ad1.scope, conversation.id, {
        sequence: 1,
      }),
    ).toMatchObject({ readThroughSequence: 2 });
    expect(
      await service.markAgentRead(ad1.id, ad1.scope, conversation.id, {
        sequence: 999,
      }),
    ).toMatchObject({ readThroughSequence: 3 });
    expect(await service.getCustomerUnreadCount(USER_1)).toEqual({
      unreadCount: 1,
    });
    await service.markCustomerRead(USER_1, conversation.id, {});
    expect(await service.getCustomerUnreadCount(USER_1)).toEqual({
      unreadCount: 0,
    });

    await service.reassignConversation(conversation.id, ad2.id, 'pahlevan');
    const assignments = await dataSource
      .getRepository(ConversationAssignment)
      .find({
        where: { conversationId: conversation.id },
        order: { createdAt: 'ASC' },
      });
    expect(assignments).toHaveLength(2);
    expect(assignments[1]).toEqual(
      expect.objectContaining({ fromAgentId: ad1.id, toAgentId: ad2.id }),
    );
    await expect(
      service.getAgentMessages(ad1.id, ad1.scope, conversation.id, {
        afterSequence: 0,
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    [
      'wrong column default',
      'ALTER TABLE public.sales_agents ALTER COLUMN active SET DEFAULT false',
    ],
    [
      'wrong CHECK definition with the expected name',
      'ALTER TABLE public.chat_messages DROP CONSTRAINT "CHK_chat_messages_sequence"; ALTER TABLE public.chat_messages ADD CONSTRAINT "CHK_chat_messages_sequence" CHECK (sequence >= 0)',
    ],
    [
      'wrong partial predicate containing both expected statuses',
      'DROP INDEX public."UQ_chat_conversations_open_customer_area"; CREATE UNIQUE INDEX "UQ_chat_conversations_open_customer_area" ON public.chat_conversations ("customerUserId", area) WHERE status IN (\'OPEN_UNASSIGNED\', \'OPEN_ASSIGNED\') AND false',
    ],
    [
      'an extra incompatible index',
      'CREATE INDEX "IDX_sales_agents_unexpected" ON public.sales_agents ("displayName")',
    ],
    [
      'an extra incompatible constraint',
      'ALTER TABLE public.sales_agents ADD CONSTRAINT "CHK_sales_agents_unexpected" CHECK (active OR NOT active)',
    ],
  ])('rejects schema drift: %s', async (_label, mutation) => {
    try {
      await dataSource.query(mutation);
      await expectMigrationFailure();
    } finally {
      await dropSalesChatObjects();
      await dataSource.query(migrationSql);
    }
  });

  it('rolls back objects created before a partial migration failure', async () => {
    await dropSalesChatObjects();
    await dataSource.query('CREATE TABLE public.sales_agents (id uuid)');
    try {
      await expectMigrationFailure();
      const [state] = await dataSource.query<
        Array<{ conversations: string | null; salesScopeType: string | null }>
      >(`
        SELECT
          pg_catalog.to_regclass('public.chat_conversations')::text AS conversations,
          pg_catalog.to_regtype('public.sales_agents_scope_enum')::text AS "salesScopeType"
      `);
      expect(state).toEqual({ conversations: null, salesScopeType: null });
    } finally {
      await dataSource.query(
        'DROP TABLE IF EXISTS public.sales_agents CASCADE',
      );
      await dataSource.query(migrationSql);
    }
  });

  async function agent(username: string): Promise<SalesAgent> {
    return dataSource.getRepository(SalesAgent).findOneOrFail({
      where: { username },
    });
  }

  async function expectMigrationFailure(): Promise<void> {
    let failure: unknown;
    try {
      await dataSource.query(migrationSql);
    } catch (error) {
      failure = error;
      await dataSource.query('ROLLBACK');
    }
    expect(failure).toBeDefined();
  }

  async function resetDisposableSchema(): Promise<void> {
    await dropSalesChatObjects();
    await dataSource.query('DROP TABLE IF EXISTS public.products CASCADE');
    await dataSource.query('DROP TABLE IF EXISTS public.users CASCADE');
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await dataSource.query(`
      CREATE TABLE public.users (
        id uuid PRIMARY KEY,
        phone varchar NOT NULL UNIQUE,
        "firstName" varchar NULL,
        "lastName" varchar NULL,
        email varchar NULL UNIQUE,
        "nationalId" varchar NULL,
        "profileCompleted" boolean NOT NULL DEFAULT false,
        "loyaltyPoints" integer NOT NULL DEFAULT 0,
        role varchar NOT NULL DEFAULT 'customer',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await dataSource.query(
      'CREATE TABLE public.products (id uuid PRIMARY KEY)',
    );
  }

  async function dropSalesChatObjects(): Promise<void> {
    await dataSource.query(
      'DROP TABLE IF EXISTS public.chat_push_subscriptions CASCADE',
    );
    await dataSource.query(
      'DROP TABLE IF EXISTS public.chat_conversation_assignments CASCADE',
    );
    await dataSource.query('DROP TABLE IF EXISTS public.chat_messages CASCADE');
    await dataSource.query(
      'DROP TABLE IF EXISTS public.chat_conversations CASCADE',
    );
    await dataSource.query('DROP TABLE IF EXISTS public.sales_agents CASCADE');
    for (const type of [
      'chat_push_owner_type_enum',
      'chat_assignment_actor_type_enum',
      'chat_messages_type_enum',
      'chat_messages_sender_type_enum',
      'chat_conversations_source_type_enum',
      'chat_conversations_channel_enum',
      'chat_conversations_status_enum',
      'sales_agents_scope_enum',
    ]) {
      await dataSource.query(`DROP TYPE IF EXISTS public.${type} CASCADE`);
    }
  }
});

function requireDisposableDatabaseUrl(): string {
  const url = process.env.SALES_CHAT_TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('SALES_CHAT_TEST_DATABASE_URL is required');
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!/(test|disposable)/i.test(databaseName)) {
    throw new Error('Test database name must contain test or disposable');
  }
  return url;
}

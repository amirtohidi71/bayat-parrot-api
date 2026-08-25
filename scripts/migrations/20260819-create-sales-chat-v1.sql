\set ON_ERROR_STOP on

BEGIN;

DO $preflight$
DECLARE
  object_name text;
  object_kind "char";
BEGIN
  IF pg_catalog.to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'required table public.users does not exist';
  END IF;
  IF pg_catalog.to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'required table public.products does not exist';
  END IF;
  IF pg_catalog.to_regprocedure('public.uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'required function public.uuid_generate_v4() does not exist';
  END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'sales_agents',
    'chat_conversations',
    'chat_messages',
    'chat_conversation_assignments',
    'chat_push_subscriptions'
  ] LOOP
    SELECT c.relkind INTO object_kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = object_name;
    IF FOUND AND object_kind <> 'r' THEN
      RAISE EXCEPTION 'public.% exists with incompatible relkind %', object_name, object_kind;
    END IF;
  END LOOP;
END
$preflight$;

DO $types$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'sales_agents_scope_enum') THEN
    CREATE TYPE public.sales_agents_scope_enum AS ENUM ('PARROT', 'PRODUCTS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'chat_conversations_status_enum') THEN
    CREATE TYPE public.chat_conversations_status_enum AS ENUM ('OPEN_UNASSIGNED', 'OPEN_ASSIGNED', 'CLOSED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'chat_conversations_channel_enum') THEN
    CREATE TYPE public.chat_conversations_channel_enum AS ENUM ('WEB');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'chat_conversations_source_type_enum') THEN
    CREATE TYPE public.chat_conversations_source_type_enum AS ENUM ('PRODUCT_PAGE', 'ACCOUNT', 'FLOATING');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'chat_messages_sender_type_enum') THEN
    CREATE TYPE public.chat_messages_sender_type_enum AS ENUM ('CUSTOMER', 'AGENT', 'SYSTEM');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'chat_messages_type_enum') THEN
    CREATE TYPE public.chat_messages_type_enum AS ENUM ('TEXT', 'CONTEXT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'chat_assignment_actor_type_enum') THEN
    CREATE TYPE public.chat_assignment_actor_type_enum AS ENUM ('AGENT_CLAIM', 'SUPERVISOR_REASSIGN');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'chat_push_owner_type_enum') THEN
    CREATE TYPE public.chat_push_owner_type_enum AS ENUM ('CUSTOMER', 'SALES_AGENT');
  END IF;
END
$types$;

DO $verify_types$
DECLARE
  actual text[];
BEGIN
  SELECT enum_range(NULL::public.sales_agents_scope_enum)::text[] INTO actual;
  IF actual IS DISTINCT FROM ARRAY['PARROT', 'PRODUCTS'] THEN RAISE EXCEPTION 'sales_agents_scope_enum mismatch'; END IF;
  SELECT enum_range(NULL::public.chat_conversations_status_enum)::text[] INTO actual;
  IF actual IS DISTINCT FROM ARRAY['OPEN_UNASSIGNED', 'OPEN_ASSIGNED', 'CLOSED'] THEN RAISE EXCEPTION 'chat_conversations_status_enum mismatch'; END IF;
  SELECT enum_range(NULL::public.chat_conversations_channel_enum)::text[] INTO actual;
  IF actual IS DISTINCT FROM ARRAY['WEB'] THEN RAISE EXCEPTION 'chat_conversations_channel_enum mismatch'; END IF;
  SELECT enum_range(NULL::public.chat_conversations_source_type_enum)::text[] INTO actual;
  IF actual IS DISTINCT FROM ARRAY['PRODUCT_PAGE', 'ACCOUNT', 'FLOATING'] THEN RAISE EXCEPTION 'chat_conversations_source_type_enum mismatch'; END IF;
  SELECT enum_range(NULL::public.chat_messages_sender_type_enum)::text[] INTO actual;
  IF actual IS DISTINCT FROM ARRAY['CUSTOMER', 'AGENT', 'SYSTEM'] THEN RAISE EXCEPTION 'chat_messages_sender_type_enum mismatch'; END IF;
  SELECT enum_range(NULL::public.chat_messages_type_enum)::text[] INTO actual;
  IF actual IS DISTINCT FROM ARRAY['TEXT', 'CONTEXT'] THEN RAISE EXCEPTION 'chat_messages_type_enum mismatch'; END IF;
  SELECT enum_range(NULL::public.chat_assignment_actor_type_enum)::text[] INTO actual;
  IF actual IS DISTINCT FROM ARRAY['AGENT_CLAIM', 'SUPERVISOR_REASSIGN'] THEN RAISE EXCEPTION 'chat_assignment_actor_type_enum mismatch'; END IF;
  SELECT enum_range(NULL::public.chat_push_owner_type_enum)::text[] INTO actual;
  IF actual IS DISTINCT FROM ARRAY['CUSTOMER', 'SALES_AGENT'] THEN RAISE EXCEPTION 'chat_push_owner_type_enum mismatch'; END IF;
END
$verify_types$;

CREATE TABLE IF NOT EXISTS public.sales_agents (
  id uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  username varchar(50) NOT NULL,
  "displayName" varchar(100) NOT NULL,
  scope public.sales_agents_scope_enum NOT NULL,
  active boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_agents_pkey PRIMARY KEY (id),
  CONSTRAINT "UQ_sales_agents_username" UNIQUE (username)
);

CREATE TABLE IF NOT EXISTS public.chat_conversations (
  id uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "customerUserId" uuid NOT NULL,
  area public.sales_agents_scope_enum NOT NULL,
  status public.chat_conversations_status_enum NOT NULL,
  "assignedAgentId" uuid NULL,
  channel public.chat_conversations_channel_enum NOT NULL DEFAULT 'WEB',
  "sourceType" public.chat_conversations_source_type_enum NULL,
  "sourceProductId" uuid NULL,
  "sourcePath" varchar(500) NULL,
  "lastSequence" integer NOT NULL DEFAULT 0,
  "customerLastReadSequence" integer NOT NULL DEFAULT 0,
  "agentLastReadSequence" integer NOT NULL DEFAULT 0,
  "lastMessagePreview" varchar(200) NULL,
  "lastMessageAt" timestamptz NOT NULL DEFAULT now(),
  "closedAt" timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_conversations_pkey PRIMARY KEY (id),
  CONSTRAINT "FK_chat_conversations_customer" FOREIGN KEY ("customerUserId") REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT "FK_chat_conversations_agent" FOREIGN KEY ("assignedAgentId") REFERENCES public.sales_agents(id) ON DELETE RESTRICT,
  CONSTRAINT "FK_chat_conversations_source_product" FOREIGN KEY ("sourceProductId") REFERENCES public.products(id) ON DELETE SET NULL,
  CONSTRAINT "CHK_chat_conversations_assignment_status" CHECK (
    (status = 'OPEN_UNASSIGNED' AND "assignedAgentId" IS NULL)
    OR (status = 'OPEN_ASSIGNED' AND "assignedAgentId" IS NOT NULL)
    OR status = 'CLOSED'
  ),
  CONSTRAINT "CHK_chat_conversations_sequences" CHECK (
    "lastSequence" >= 0
    AND "customerLastReadSequence" >= 0
    AND "agentLastReadSequence" >= 0
    AND "customerLastReadSequence" <= "lastSequence"
    AND "agentLastReadSequence" <= "lastSequence"
  )
);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "conversationId" uuid NOT NULL,
  "senderType" public.chat_messages_sender_type_enum NOT NULL,
  "senderUserId" uuid NULL,
  "senderAgentId" uuid NULL,
  type public.chat_messages_type_enum NOT NULL,
  text varchar(4000) NULL,
  sequence integer NOT NULL,
  "clientMessageId" uuid NULL,
  "contextProductId" uuid NULL,
  "contextSourcePath" varchar(500) NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT "FK_chat_messages_conversation" FOREIGN KEY ("conversationId") REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  CONSTRAINT "FK_chat_messages_sender_user" FOREIGN KEY ("senderUserId") REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT "FK_chat_messages_sender_agent" FOREIGN KEY ("senderAgentId") REFERENCES public.sales_agents(id) ON DELETE RESTRICT,
  CONSTRAINT "FK_chat_messages_context_product" FOREIGN KEY ("contextProductId") REFERENCES public.products(id) ON DELETE SET NULL,
  CONSTRAINT "CHK_chat_messages_payload" CHECK (
    (type = 'TEXT' AND text IS NOT NULL AND char_length(text) BETWEEN 1 AND 4000
      AND "clientMessageId" IS NOT NULL AND "senderType" IN ('CUSTOMER', 'AGENT'))
    OR
    (type = 'CONTEXT' AND text IS NULL AND "clientMessageId" IS NULL AND "senderType" = 'SYSTEM')
  ),
  CONSTRAINT "CHK_chat_messages_sender_identity" CHECK (
    ("senderType" = 'CUSTOMER' AND "senderUserId" IS NOT NULL AND "senderAgentId" IS NULL)
    OR ("senderType" = 'AGENT' AND "senderUserId" IS NULL AND "senderAgentId" IS NOT NULL)
    OR ("senderType" = 'SYSTEM' AND "senderUserId" IS NULL AND "senderAgentId" IS NULL)
  ),
  CONSTRAINT "CHK_chat_messages_sequence" CHECK (sequence > 0)
);

CREATE TABLE IF NOT EXISTS public.chat_conversation_assignments (
  id uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "conversationId" uuid NOT NULL,
  "fromAgentId" uuid NULL,
  "toAgentId" uuid NOT NULL,
  "actorType" public.chat_assignment_actor_type_enum NOT NULL,
  "actorAgentId" uuid NULL,
  "actorAdminUsername" varchar(50) NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_conversation_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT "FK_chat_assignments_conversation" FOREIGN KEY ("conversationId") REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  CONSTRAINT "FK_chat_assignments_from_agent" FOREIGN KEY ("fromAgentId") REFERENCES public.sales_agents(id) ON DELETE RESTRICT,
  CONSTRAINT "FK_chat_assignments_to_agent" FOREIGN KEY ("toAgentId") REFERENCES public.sales_agents(id) ON DELETE RESTRICT,
  CONSTRAINT "FK_chat_assignments_actor_agent" FOREIGN KEY ("actorAgentId") REFERENCES public.sales_agents(id) ON DELETE RESTRICT,
  CONSTRAINT "CHK_chat_assignments_actor_identity" CHECK (
    ("actorType" = 'AGENT_CLAIM' AND "actorAgentId" IS NOT NULL AND "actorAdminUsername" IS NULL)
    OR ("actorType" = 'SUPERVISOR_REASSIGN' AND "actorAgentId" IS NULL AND "actorAdminUsername" IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.chat_push_subscriptions (
  id uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "ownerType" public.chat_push_owner_type_enum NOT NULL,
  "customerUserId" uuid NULL,
  "salesAgentId" uuid NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_push_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT "FK_chat_push_subscriptions_customer" FOREIGN KEY ("customerUserId") REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT "FK_chat_push_subscriptions_agent" FOREIGN KEY ("salesAgentId") REFERENCES public.sales_agents(id) ON DELETE CASCADE,
  CONSTRAINT "CHK_chat_push_subscriptions_owner" CHECK (
    ("ownerType" = 'CUSTOMER' AND "customerUserId" IS NOT NULL AND "salesAgentId" IS NULL)
    OR ("ownerType" = 'SALES_AGENT' AND "salesAgentId" IS NOT NULL AND "customerUserId" IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS "IDX_sales_agents_scope_active"
  ON public.sales_agents USING btree (scope, active, username);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chat_conversations_open_customer_area"
  ON public.chat_conversations USING btree ("customerUserId", area)
  WHERE status IN ('OPEN_UNASSIGNED', 'OPEN_ASSIGNED');
CREATE INDEX IF NOT EXISTS "IDX_chat_conversations_customer_activity"
  ON public.chat_conversations USING btree ("customerUserId", "lastMessageAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS "IDX_chat_conversations_agent_inbox"
  ON public.chat_conversations USING btree ("assignedAgentId", status, "lastMessageAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS "IDX_chat_conversations_queue"
  ON public.chat_conversations USING btree (area, status, "lastMessageAt", id);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chat_messages_conversation_sequence"
  ON public.chat_messages USING btree ("conversationId", sequence);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chat_messages_client_retry"
  ON public.chat_messages USING btree ("conversationId", "senderType", "clientMessageId");
CREATE INDEX IF NOT EXISTS "IDX_chat_messages_conversation_poll"
  ON public.chat_messages USING btree ("conversationId", sequence, id);

CREATE INDEX IF NOT EXISTS "IDX_chat_assignments_conversation_time"
  ON public.chat_conversation_assignments USING btree ("conversationId", "createdAt", id);
CREATE INDEX IF NOT EXISTS "IDX_chat_assignments_agent_time"
  ON public.chat_conversation_assignments USING btree ("toAgentId", "createdAt", id);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chat_push_subscriptions_endpoint"
  ON public.chat_push_subscriptions USING btree (endpoint);
CREATE INDEX IF NOT EXISTS "IDX_chat_push_subscriptions_customer"
  ON public.chat_push_subscriptions USING btree ("customerUserId");
CREATE INDEX IF NOT EXISTS "IDX_chat_push_subscriptions_agent"
  ON public.chat_push_subscriptions USING btree ("salesAgentId");

INSERT INTO public.sales_agents (id, username, "displayName", scope, active)
VALUES
  ('30000001-0000-4000-8000-000000000001', 'ad1', 'Ad1', 'PARROT', true),
  ('30000002-0000-4000-8000-000000000002', 'ad2', 'Ad2', 'PARROT', true),
  ('30000003-0000-4000-8000-000000000003', 'ad3', 'Ad3', 'PARROT', true),
  ('30000004-0000-4000-8000-000000000004', 'ad4', 'Ad4', 'PARROT', true),
  ('30000005-0000-4000-8000-000000000005', 'ad5', 'Ad5', 'PRODUCTS', true),
  ('30000006-0000-4000-8000-000000000006', 'ad6', 'Ad6', 'PRODUCTS', true)
ON CONFLICT (username) DO NOTHING;

DO $verify$
DECLARE
  table_name text;
  actual_count integer;
  open_index_columns text[];
  open_index_unique boolean;
  open_index_predicate text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sales_agents',
    'chat_conversations',
    'chat_messages',
    'chat_conversation_assignments',
    'chat_push_subscriptions'
  ] LOOP
    IF pg_catalog.to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'required table public.% is missing', table_name;
    END IF;
  END LOOP;

  IF EXISTS (
    WITH expected(table_name, column_name, type_name, not_null) AS (
      VALUES
        ('sales_agents', 'id', 'uuid', true),
        ('sales_agents', 'username', 'character varying(50)', true),
        ('sales_agents', 'displayName', 'character varying(100)', true),
        ('sales_agents', 'scope', 'sales_agents_scope_enum', true),
        ('sales_agents', 'active', 'boolean', true),
        ('sales_agents', 'createdAt', 'timestamp with time zone', true),
        ('sales_agents', 'updatedAt', 'timestamp with time zone', true),
        ('chat_conversations', 'id', 'uuid', true),
        ('chat_conversations', 'customerUserId', 'uuid', true),
        ('chat_conversations', 'area', 'sales_agents_scope_enum', true),
        ('chat_conversations', 'status', 'chat_conversations_status_enum', true),
        ('chat_conversations', 'assignedAgentId', 'uuid', false),
        ('chat_conversations', 'channel', 'chat_conversations_channel_enum', true),
        ('chat_conversations', 'sourceType', 'chat_conversations_source_type_enum', false),
        ('chat_conversations', 'sourceProductId', 'uuid', false),
        ('chat_conversations', 'sourcePath', 'character varying(500)', false),
        ('chat_conversations', 'lastSequence', 'integer', true),
        ('chat_conversations', 'customerLastReadSequence', 'integer', true),
        ('chat_conversations', 'agentLastReadSequence', 'integer', true),
        ('chat_conversations', 'lastMessagePreview', 'character varying(200)', false),
        ('chat_conversations', 'lastMessageAt', 'timestamp with time zone', true),
        ('chat_conversations', 'closedAt', 'timestamp with time zone', false),
        ('chat_conversations', 'createdAt', 'timestamp with time zone', true),
        ('chat_conversations', 'updatedAt', 'timestamp with time zone', true),
        ('chat_messages', 'id', 'uuid', true),
        ('chat_messages', 'conversationId', 'uuid', true),
        ('chat_messages', 'senderType', 'chat_messages_sender_type_enum', true),
        ('chat_messages', 'senderUserId', 'uuid', false),
        ('chat_messages', 'senderAgentId', 'uuid', false),
        ('chat_messages', 'type', 'chat_messages_type_enum', true),
        ('chat_messages', 'text', 'character varying(4000)', false),
        ('chat_messages', 'sequence', 'integer', true),
        ('chat_messages', 'clientMessageId', 'uuid', false),
        ('chat_messages', 'contextProductId', 'uuid', false),
        ('chat_messages', 'contextSourcePath', 'character varying(500)', false),
        ('chat_messages', 'createdAt', 'timestamp with time zone', true),
        ('chat_conversation_assignments', 'id', 'uuid', true),
        ('chat_conversation_assignments', 'conversationId', 'uuid', true),
        ('chat_conversation_assignments', 'fromAgentId', 'uuid', false),
        ('chat_conversation_assignments', 'toAgentId', 'uuid', true),
        ('chat_conversation_assignments', 'actorType', 'chat_assignment_actor_type_enum', true),
        ('chat_conversation_assignments', 'actorAgentId', 'uuid', false),
        ('chat_conversation_assignments', 'actorAdminUsername', 'character varying(50)', false),
        ('chat_conversation_assignments', 'createdAt', 'timestamp with time zone', true),
        ('chat_push_subscriptions', 'id', 'uuid', true),
        ('chat_push_subscriptions', 'ownerType', 'chat_push_owner_type_enum', true),
        ('chat_push_subscriptions', 'customerUserId', 'uuid', false),
        ('chat_push_subscriptions', 'salesAgentId', 'uuid', false),
        ('chat_push_subscriptions', 'endpoint', 'text', true),
        ('chat_push_subscriptions', 'p256dh', 'text', true),
        ('chat_push_subscriptions', 'auth', 'text', true),
        ('chat_push_subscriptions', 'createdAt', 'timestamp with time zone', true),
        ('chat_push_subscriptions', 'updatedAt', 'timestamp with time zone', true)
    ),
    actual AS (
      SELECT
        c.relname::text,
        a.attname::text,
        pg_catalog.format_type(a.atttypid, a.atttypmod),
        a.attnotnull
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('sales_agents', 'chat_conversations', 'chat_messages', 'chat_conversation_assignments', 'chat_push_subscriptions')
        AND a.attnum > 0 AND NOT a.attisdropped
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'Sales Chat V1 column definition mismatch';
  END IF;

  IF EXISTS (
    WITH expected_defaults(table_name, column_name, default_expression) AS (
      VALUES
        ('sales_agents', 'id', 'uuid_generate_v4()'),
        ('sales_agents', 'active', 'true'),
        ('sales_agents', 'createdAt', 'now()'),
        ('sales_agents', 'updatedAt', 'now()'),
        ('chat_conversations', 'id', 'uuid_generate_v4()'),
        ('chat_conversations', 'channel', '''WEB''::chat_conversations_channel_enum'),
        ('chat_conversations', 'lastSequence', '0'),
        ('chat_conversations', 'customerLastReadSequence', '0'),
        ('chat_conversations', 'agentLastReadSequence', '0'),
        ('chat_conversations', 'lastMessageAt', 'now()'),
        ('chat_conversations', 'createdAt', 'now()'),
        ('chat_conversations', 'updatedAt', 'now()'),
        ('chat_messages', 'id', 'uuid_generate_v4()'),
        ('chat_messages', 'createdAt', 'now()'),
        ('chat_conversation_assignments', 'id', 'uuid_generate_v4()'),
        ('chat_conversation_assignments', 'createdAt', 'now()'),
        ('chat_push_subscriptions', 'id', 'uuid_generate_v4()'),
        ('chat_push_subscriptions', 'createdAt', 'now()'),
        ('chat_push_subscriptions', 'updatedAt', 'now()')
    ),
    expected AS (
      SELECT
        relation.relname::text AS table_name,
        attribute_row.attname::text AS column_name,
        regexp_replace(
          replace(COALESCE(expected_defaults.default_expression, ''), 'public.', ''),
          '\s+', '', 'g'
        ) AS default_expression,
        ''::text AS identity_state,
        ''::text AS generated_state
      FROM pg_catalog.pg_attribute attribute_row
      JOIN pg_catalog.pg_class relation ON relation.oid = attribute_row.attrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      LEFT JOIN expected_defaults
        ON expected_defaults.table_name = relation.relname
       AND expected_defaults.column_name = attribute_row.attname
      WHERE namespace_row.nspname = 'public'
        AND relation.relname IN ('sales_agents', 'chat_conversations', 'chat_messages', 'chat_conversation_assignments', 'chat_push_subscriptions')
        AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
    ),
    actual AS (
      SELECT
        relation.relname::text AS table_name,
        attribute_row.attname::text AS column_name,
        regexp_replace(
          replace(COALESCE(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), ''), 'public.', ''),
          '\s+', '', 'g'
        ) AS default_expression,
        attribute_row.attidentity::text AS identity_state,
        attribute_row.attgenerated::text AS generated_state
      FROM pg_catalog.pg_attribute attribute_row
      JOIN pg_catalog.pg_class relation ON relation.oid = attribute_row.attrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef default_row
        ON default_row.adrelid = attribute_row.attrelid
       AND default_row.adnum = attribute_row.attnum
      WHERE namespace_row.nspname = 'public'
        AND relation.relname IN ('sales_agents', 'chat_conversations', 'chat_messages', 'chat_conversation_assignments', 'chat_push_subscriptions')
        AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'Sales Chat V1 column default/identity/generated definition mismatch';
  END IF;

  SELECT count(*) INTO actual_count
  FROM public.sales_agents
  WHERE (id, username, "displayName", scope, active) IN (
    ('30000001-0000-4000-8000-000000000001'::uuid, 'ad1', 'Ad1', 'PARROT'::public.sales_agents_scope_enum, true),
    ('30000002-0000-4000-8000-000000000002'::uuid, 'ad2', 'Ad2', 'PARROT'::public.sales_agents_scope_enum, true),
    ('30000003-0000-4000-8000-000000000003'::uuid, 'ad3', 'Ad3', 'PARROT'::public.sales_agents_scope_enum, true),
    ('30000004-0000-4000-8000-000000000004'::uuid, 'ad4', 'Ad4', 'PARROT'::public.sales_agents_scope_enum, true),
    ('30000005-0000-4000-8000-000000000005'::uuid, 'ad5', 'Ad5', 'PRODUCTS'::public.sales_agents_scope_enum, true),
    ('30000006-0000-4000-8000-000000000006'::uuid, 'ad6', 'Ad6', 'PRODUCTS'::public.sales_agents_scope_enum, true)
  );
  IF actual_count <> 6 THEN
    RAISE EXCEPTION 'Sales Agent seed identity mismatch';
  END IF;

  SELECT
    ARRAY(
      SELECT a.attname::text
      FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = i.indrelid AND a.attnum = key.attnum
      ORDER BY key.position
    ),
    i.indisunique,
    pg_catalog.pg_get_expr(i.indpred, i.indrelid)
  INTO open_index_columns, open_index_unique, open_index_predicate
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.chat_conversations'::regclass
    AND c.relname = 'UQ_chat_conversations_open_customer_area';

  IF open_index_columns IS DISTINCT FROM ARRAY['customerUserId', 'area']
     OR open_index_unique IS DISTINCT FROM true
     OR open_index_predicate IS NULL
     OR regexp_replace(
          regexp_replace(
            lower(open_index_predicate),
            '::(public\.)?chat_conversations_status_enum', '', 'g'
          ),
          '[\s()"\[\]]', '', 'g'
        ) <> 'status=anyarray''open_unassigned'',''open_assigned''' THEN
    RAISE EXCEPTION 'open conversation uniqueness index mismatch';
  END IF;

  IF EXISTS (
    WITH expected(name) AS (
      VALUES
        ('IDX_sales_agents_scope_active'),
        ('UQ_chat_conversations_open_customer_area'),
        ('IDX_chat_conversations_customer_activity'),
        ('IDX_chat_conversations_agent_inbox'),
        ('IDX_chat_conversations_queue'),
        ('UQ_chat_messages_conversation_sequence'),
        ('UQ_chat_messages_client_retry'),
        ('IDX_chat_messages_conversation_poll'),
        ('IDX_chat_assignments_conversation_time'),
        ('IDX_chat_assignments_agent_time'),
        ('UQ_chat_push_subscriptions_endpoint'),
        ('IDX_chat_push_subscriptions_customer'),
        ('IDX_chat_push_subscriptions_agent')
    ),
    actual(name) AS (
      SELECT indexname::text FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (SELECT name FROM expected)
    )
    SELECT * FROM expected EXCEPT SELECT * FROM actual
  ) THEN
    RAISE EXCEPTION 'one or more Sales Chat V1 indexes are missing';
  END IF;
END
$verify$;

DO $strict_relational_verification$
DECLARE
  spec jsonb;
  source_column smallint;
  target_column smallint;
  index_method text;
  index_unique boolean;
  index_columns text[];
  index_descending boolean[];
  index_valid boolean;
  index_ready boolean;
  index_live boolean;
  index_nulls_first boolean[];
  index_column_collations boolean;
  index_default_opclasses boolean;
  actual_definition text;
  normalized_actual text;
  normalized_expected text;
BEGIN
  IF EXISTS (
    WITH expected(table_name, constraint_name) AS (
      VALUES
        ('sales_agents', 'sales_agents_pkey'),
        ('sales_agents', 'UQ_sales_agents_username'),
        ('chat_conversations', 'chat_conversations_pkey'),
        ('chat_conversations', 'FK_chat_conversations_customer'),
        ('chat_conversations', 'FK_chat_conversations_agent'),
        ('chat_conversations', 'FK_chat_conversations_source_product'),
        ('chat_conversations', 'CHK_chat_conversations_assignment_status'),
        ('chat_conversations', 'CHK_chat_conversations_sequences'),
        ('chat_messages', 'chat_messages_pkey'),
        ('chat_messages', 'FK_chat_messages_conversation'),
        ('chat_messages', 'FK_chat_messages_sender_user'),
        ('chat_messages', 'FK_chat_messages_sender_agent'),
        ('chat_messages', 'FK_chat_messages_context_product'),
        ('chat_messages', 'CHK_chat_messages_payload'),
        ('chat_messages', 'CHK_chat_messages_sender_identity'),
        ('chat_messages', 'CHK_chat_messages_sequence'),
        ('chat_conversation_assignments', 'chat_conversation_assignments_pkey'),
        ('chat_conversation_assignments', 'FK_chat_assignments_conversation'),
        ('chat_conversation_assignments', 'FK_chat_assignments_from_agent'),
        ('chat_conversation_assignments', 'FK_chat_assignments_to_agent'),
        ('chat_conversation_assignments', 'FK_chat_assignments_actor_agent'),
        ('chat_conversation_assignments', 'CHK_chat_assignments_actor_identity'),
        ('chat_push_subscriptions', 'chat_push_subscriptions_pkey'),
        ('chat_push_subscriptions', 'FK_chat_push_subscriptions_customer'),
        ('chat_push_subscriptions', 'FK_chat_push_subscriptions_agent'),
        ('chat_push_subscriptions', 'CHK_chat_push_subscriptions_owner')
    ),
    actual(table_name, constraint_name) AS (
      SELECT relation.relname::text, constraint_row.conname::text
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND relation.relname IN (
          'sales_agents',
          'chat_conversations',
          'chat_messages',
          'chat_conversation_assignments',
          'chat_push_subscriptions'
        )
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'Sales Chat V1 constraint name set mismatch';
  END IF;

  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','sales_agents'),
    jsonb_build_object('table','chat_conversations'),
    jsonb_build_object('table','chat_messages'),
    jsonb_build_object('table','chat_conversation_assignments'),
    jsonb_build_object('table','chat_push_subscriptions')
  )) LOOP
    PERFORM 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = format('public.%I', spec->>'table')::regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute_row.attnum
        FROM pg_catalog.pg_attribute attribute_row
        WHERE attribute_row.attrelid = constraint_row.conrelid
          AND attribute_row.attname = 'id'
      )]::smallint[];
    IF NOT FOUND THEN
      RAISE EXCEPTION 'public.% primary key definition mismatch', spec->>'table';
    END IF;
  END LOOP;

  PERFORM 1
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'public.sales_agents'::regclass
    AND constraint_row.conname = 'UQ_sales_agents_username'
    AND constraint_row.contype = 'u'
    AND constraint_row.convalidated
    AND NOT constraint_row.condeferrable
    AND constraint_row.conkey = ARRAY[(
      SELECT attribute_row.attnum
      FROM pg_catalog.pg_attribute attribute_row
      WHERE attribute_row.attrelid = constraint_row.conrelid
        AND attribute_row.attname = 'username'
    )]::smallint[];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sales agent username unique constraint mismatch';
  END IF;

  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','chat_conversations','name','FK_chat_conversations_customer','column','customerUserId','target','users','targetColumn','id','delete','c'),
    jsonb_build_object('table','chat_conversations','name','FK_chat_conversations_agent','column','assignedAgentId','target','sales_agents','targetColumn','id','delete','r'),
    jsonb_build_object('table','chat_conversations','name','FK_chat_conversations_source_product','column','sourceProductId','target','products','targetColumn','id','delete','n'),
    jsonb_build_object('table','chat_messages','name','FK_chat_messages_conversation','column','conversationId','target','chat_conversations','targetColumn','id','delete','c'),
    jsonb_build_object('table','chat_messages','name','FK_chat_messages_sender_user','column','senderUserId','target','users','targetColumn','id','delete','n'),
    jsonb_build_object('table','chat_messages','name','FK_chat_messages_sender_agent','column','senderAgentId','target','sales_agents','targetColumn','id','delete','r'),
    jsonb_build_object('table','chat_messages','name','FK_chat_messages_context_product','column','contextProductId','target','products','targetColumn','id','delete','n'),
    jsonb_build_object('table','chat_conversation_assignments','name','FK_chat_assignments_conversation','column','conversationId','target','chat_conversations','targetColumn','id','delete','c'),
    jsonb_build_object('table','chat_conversation_assignments','name','FK_chat_assignments_from_agent','column','fromAgentId','target','sales_agents','targetColumn','id','delete','r'),
    jsonb_build_object('table','chat_conversation_assignments','name','FK_chat_assignments_to_agent','column','toAgentId','target','sales_agents','targetColumn','id','delete','r'),
    jsonb_build_object('table','chat_conversation_assignments','name','FK_chat_assignments_actor_agent','column','actorAgentId','target','sales_agents','targetColumn','id','delete','r'),
    jsonb_build_object('table','chat_push_subscriptions','name','FK_chat_push_subscriptions_customer','column','customerUserId','target','users','targetColumn','id','delete','c'),
    jsonb_build_object('table','chat_push_subscriptions','name','FK_chat_push_subscriptions_agent','column','salesAgentId','target','sales_agents','targetColumn','id','delete','c')
  )) LOOP
    SELECT attribute_row.attnum INTO source_column
    FROM pg_catalog.pg_attribute attribute_row
    WHERE attribute_row.attrelid = format('public.%I', spec->>'table')::regclass
      AND attribute_row.attname = spec->>'column';
    SELECT attribute_row.attnum INTO target_column
    FROM pg_catalog.pg_attribute attribute_row
    WHERE attribute_row.attrelid = format('public.%I', spec->>'target')::regclass
      AND attribute_row.attname = spec->>'targetColumn';

    PERFORM 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = format('public.%I', spec->>'table')::regclass
      AND constraint_row.conname = spec->>'name'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = format('public.%I', spec->>'target')::regclass
      AND constraint_row.conkey = ARRAY[source_column]::smallint[]
      AND constraint_row.confkey = ARRAY[target_column]::smallint[]
      AND constraint_row.confdeltype = (spec->>'delete')::"char"
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confmatchtype = 's'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'foreign key public.%.% definition mismatch', spec->>'table', spec->>'name';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid IN (
      'public.chat_conversations'::regclass,
      'public.chat_messages'::regclass,
      'public.chat_conversation_assignments'::regclass,
      'public.chat_push_subscriptions'::regclass
    )
      AND constraint_row.contype = 'c'
      AND NOT constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'one or more Sales Chat V1 CHECK constraints are not validated';
  END IF;

  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','chat_conversations','name','CHK_chat_conversations_assignment_status','definition','CHECK ((((status = ''OPEN_UNASSIGNED''::chat_conversations_status_enum) AND ("assignedAgentId" IS NULL)) OR ((status = ''OPEN_ASSIGNED''::chat_conversations_status_enum) AND ("assignedAgentId" IS NOT NULL)) OR (status = ''CLOSED''::chat_conversations_status_enum)))'),
    jsonb_build_object('table','chat_conversations','name','CHK_chat_conversations_sequences','definition','CHECK ((("lastSequence" >= 0) AND ("customerLastReadSequence" >= 0) AND ("agentLastReadSequence" >= 0) AND ("customerLastReadSequence" <= "lastSequence") AND ("agentLastReadSequence" <= "lastSequence")))'),
    jsonb_build_object('table','chat_messages','name','CHK_chat_messages_payload','definition','CHECK ((((type = ''TEXT''::chat_messages_type_enum) AND (text IS NOT NULL) AND ((char_length((text)::text) >= 1) AND (char_length((text)::text) <= 4000)) AND ("clientMessageId" IS NOT NULL) AND ("senderType" = ANY (ARRAY[''CUSTOMER''::chat_messages_sender_type_enum, ''AGENT''::chat_messages_sender_type_enum]))) OR ((type = ''CONTEXT''::chat_messages_type_enum) AND (text IS NULL) AND ("clientMessageId" IS NULL) AND ("senderType" = ''SYSTEM''::chat_messages_sender_type_enum))))'),
    jsonb_build_object('table','chat_messages','name','CHK_chat_messages_sender_identity','definition','CHECK (((("senderType" = ''CUSTOMER''::chat_messages_sender_type_enum) AND ("senderUserId" IS NOT NULL) AND ("senderAgentId" IS NULL)) OR (("senderType" = ''AGENT''::chat_messages_sender_type_enum) AND ("senderUserId" IS NULL) AND ("senderAgentId" IS NOT NULL)) OR (("senderType" = ''SYSTEM''::chat_messages_sender_type_enum) AND ("senderUserId" IS NULL) AND ("senderAgentId" IS NULL))))'),
    jsonb_build_object('table','chat_messages','name','CHK_chat_messages_sequence','definition','CHECK ((sequence > 0))'),
    jsonb_build_object('table','chat_conversation_assignments','name','CHK_chat_assignments_actor_identity','definition','CHECK (((("actorType" = ''AGENT_CLAIM''::chat_assignment_actor_type_enum) AND ("actorAgentId" IS NOT NULL) AND ("actorAdminUsername" IS NULL)) OR (("actorType" = ''SUPERVISOR_REASSIGN''::chat_assignment_actor_type_enum) AND ("actorAgentId" IS NULL) AND ("actorAdminUsername" IS NOT NULL))))'),
    jsonb_build_object('table','chat_push_subscriptions','name','CHK_chat_push_subscriptions_owner','definition','CHECK (((("ownerType" = ''CUSTOMER''::chat_push_owner_type_enum) AND ("customerUserId" IS NOT NULL) AND ("salesAgentId" IS NULL)) OR (("ownerType" = ''SALES_AGENT''::chat_push_owner_type_enum) AND ("salesAgentId" IS NOT NULL) AND ("customerUserId" IS NULL))))')
  )) LOOP
    SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
    INTO actual_definition
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = format('public.%I', spec->>'table')::regclass
      AND constraint_row.conname = spec->>'name'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CHECK constraint public.%.% is missing, invalid, or has the wrong type', spec->>'table', spec->>'name';
    END IF;

    normalized_actual := lower(actual_definition);
    normalized_expected := lower(spec->>'definition');
    normalized_actual := regexp_replace(normalized_actual, '::(public\.)?(chat_conversations_status_enum|chat_messages_sender_type_enum|chat_messages_type_enum|chat_assignment_actor_type_enum|chat_push_owner_type_enum|text|character varying)', '', 'g');
    normalized_expected := regexp_replace(normalized_expected, '::(public\.)?(chat_conversations_status_enum|chat_messages_sender_type_enum|chat_messages_type_enum|chat_assignment_actor_type_enum|chat_push_owner_type_enum|text|character varying)', '', 'g');
    normalized_actual := regexp_replace(normalized_actual, '[\s"]', '', 'g');
    normalized_expected := regexp_replace(normalized_expected, '[\s"]', '', 'g');
    IF normalized_actual <> normalized_expected THEN
      RAISE EXCEPTION 'CHECK constraint public.%.% definition mismatch: %', spec->>'table', spec->>'name', actual_definition;
    END IF;
  END LOOP;

  IF EXISTS (
    WITH expected(table_name, index_name) AS (
      VALUES
        ('sales_agents', 'sales_agents_pkey'),
        ('sales_agents', 'UQ_sales_agents_username'),
        ('sales_agents', 'IDX_sales_agents_scope_active'),
        ('chat_conversations', 'chat_conversations_pkey'),
        ('chat_conversations', 'UQ_chat_conversations_open_customer_area'),
        ('chat_conversations', 'IDX_chat_conversations_customer_activity'),
        ('chat_conversations', 'IDX_chat_conversations_agent_inbox'),
        ('chat_conversations', 'IDX_chat_conversations_queue'),
        ('chat_messages', 'chat_messages_pkey'),
        ('chat_messages', 'UQ_chat_messages_conversation_sequence'),
        ('chat_messages', 'UQ_chat_messages_client_retry'),
        ('chat_messages', 'IDX_chat_messages_conversation_poll'),
        ('chat_conversation_assignments', 'chat_conversation_assignments_pkey'),
        ('chat_conversation_assignments', 'IDX_chat_assignments_conversation_time'),
        ('chat_conversation_assignments', 'IDX_chat_assignments_agent_time'),
        ('chat_push_subscriptions', 'chat_push_subscriptions_pkey'),
        ('chat_push_subscriptions', 'UQ_chat_push_subscriptions_endpoint'),
        ('chat_push_subscriptions', 'IDX_chat_push_subscriptions_customer'),
        ('chat_push_subscriptions', 'IDX_chat_push_subscriptions_agent')
    ),
    actual(table_name, index_name) AS (
      SELECT table_name::text, index_name::text
      FROM (
        SELECT relation.relname AS table_name, index_relation.relname AS index_name
        FROM pg_catalog.pg_index index_row
        JOIN pg_catalog.pg_class relation ON relation.oid = index_row.indrelid
        JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
        JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND relation.relname IN (
            'sales_agents',
            'chat_conversations',
            'chat_messages',
            'chat_conversation_assignments',
            'chat_push_subscriptions'
          )
      ) index_names
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'Sales Chat V1 index name set mismatch';
  END IF;

  FOR spec IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('table','sales_agents','name','sales_agents_pkey','unique',true,'columns',jsonb_build_array('id'),'descending',jsonb_build_array(false)),
    jsonb_build_object('table','sales_agents','name','UQ_sales_agents_username','unique',true,'columns',jsonb_build_array('username'),'descending',jsonb_build_array(false)),
    jsonb_build_object('table','sales_agents','name','IDX_sales_agents_scope_active','unique',false,'columns',jsonb_build_array('scope','active','username'),'descending',jsonb_build_array(false,false,false)),
    jsonb_build_object('table','chat_conversations','name','chat_conversations_pkey','unique',true,'columns',jsonb_build_array('id'),'descending',jsonb_build_array(false)),
    jsonb_build_object('table','chat_conversations','name','IDX_chat_conversations_customer_activity','unique',false,'columns',jsonb_build_array('customerUserId','lastMessageAt','id'),'descending',jsonb_build_array(false,true,true)),
    jsonb_build_object('table','chat_conversations','name','IDX_chat_conversations_agent_inbox','unique',false,'columns',jsonb_build_array('assignedAgentId','status','lastMessageAt','id'),'descending',jsonb_build_array(false,false,true,true)),
    jsonb_build_object('table','chat_conversations','name','IDX_chat_conversations_queue','unique',false,'columns',jsonb_build_array('area','status','lastMessageAt','id'),'descending',jsonb_build_array(false,false,false,false)),
    jsonb_build_object('table','chat_messages','name','UQ_chat_messages_conversation_sequence','unique',true,'columns',jsonb_build_array('conversationId','sequence'),'descending',jsonb_build_array(false,false)),
    jsonb_build_object('table','chat_messages','name','chat_messages_pkey','unique',true,'columns',jsonb_build_array('id'),'descending',jsonb_build_array(false)),
    jsonb_build_object('table','chat_messages','name','UQ_chat_messages_client_retry','unique',true,'columns',jsonb_build_array('conversationId','senderType','clientMessageId'),'descending',jsonb_build_array(false,false,false)),
    jsonb_build_object('table','chat_messages','name','IDX_chat_messages_conversation_poll','unique',false,'columns',jsonb_build_array('conversationId','sequence','id'),'descending',jsonb_build_array(false,false,false)),
    jsonb_build_object('table','chat_conversation_assignments','name','IDX_chat_assignments_conversation_time','unique',false,'columns',jsonb_build_array('conversationId','createdAt','id'),'descending',jsonb_build_array(false,false,false)),
    jsonb_build_object('table','chat_conversation_assignments','name','chat_conversation_assignments_pkey','unique',true,'columns',jsonb_build_array('id'),'descending',jsonb_build_array(false)),
    jsonb_build_object('table','chat_conversation_assignments','name','IDX_chat_assignments_agent_time','unique',false,'columns',jsonb_build_array('toAgentId','createdAt','id'),'descending',jsonb_build_array(false,false,false)),
    jsonb_build_object('table','chat_push_subscriptions','name','UQ_chat_push_subscriptions_endpoint','unique',true,'columns',jsonb_build_array('endpoint'),'descending',jsonb_build_array(false)),
    jsonb_build_object('table','chat_push_subscriptions','name','chat_push_subscriptions_pkey','unique',true,'columns',jsonb_build_array('id'),'descending',jsonb_build_array(false)),
    jsonb_build_object('table','chat_push_subscriptions','name','IDX_chat_push_subscriptions_customer','unique',false,'columns',jsonb_build_array('customerUserId'),'descending',jsonb_build_array(false)),
    jsonb_build_object('table','chat_push_subscriptions','name','IDX_chat_push_subscriptions_agent','unique',false,'columns',jsonb_build_array('salesAgentId'),'descending',jsonb_build_array(false))
  )) LOOP
    SELECT
      access_method.amname,
      index_row.indisunique,
      array_agg(attribute_row.attname::text ORDER BY index_key.ordinality),
      array_agg((index_row.indoption[index_key.ordinality::integer - 1] & 1) = 1 ORDER BY index_key.ordinality),
      array_agg((index_row.indoption[index_key.ordinality::integer - 1] & 2) = 2 ORDER BY index_key.ordinality),
      index_row.indisvalid,
      index_row.indisready,
      index_row.indislive,
      bool_and(index_row.indcollation[index_key.ordinality::integer - 1] = attribute_row.attcollation),
      bool_and(opclass_row.opcdefault)
    INTO
      index_method,
      index_unique,
      index_columns,
      index_descending,
      index_nulls_first,
      index_valid,
      index_ready,
      index_live,
      index_column_collations,
      index_default_opclasses
    FROM pg_catalog.pg_index index_row
    JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam
    CROSS JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY AS index_key(attnum, ordinality)
    JOIN pg_catalog.pg_attribute attribute_row
      ON attribute_row.attrelid = index_row.indrelid
     AND attribute_row.attnum = index_key.attnum
    JOIN pg_catalog.pg_opclass opclass_row
      ON opclass_row.oid = index_row.indclass[index_key.ordinality::integer - 1]
     AND opclass_row.opcmethod = index_relation.relam
    WHERE index_row.indrelid = format('public.%I', spec->>'table')::regclass
      AND index_relation.relname = spec->>'name'
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = jsonb_array_length(spec->'columns')
      AND index_row.indnatts = jsonb_array_length(spec->'columns')
    GROUP BY
      access_method.amname,
      index_row.indisunique,
      index_row.indisvalid,
      index_row.indisready,
      index_row.indislive;

    IF NOT FOUND
       OR index_method <> 'btree'
       OR index_unique <> (spec->>'unique')::boolean
       OR NOT index_valid
       OR NOT index_ready
       OR NOT index_live
       OR NOT index_column_collations
       OR NOT index_default_opclasses
       OR index_columns <> ARRAY(
         SELECT expected_column.value
         FROM jsonb_array_elements_text(spec->'columns') WITH ORDINALITY AS expected_column(value, ordinality)
         ORDER BY expected_column.ordinality
       )
       OR index_descending <> ARRAY(
         SELECT expected_direction.value::boolean
         FROM jsonb_array_elements_text(spec->'descending') WITH ORDINALITY AS expected_direction(value, ordinality)
         ORDER BY expected_direction.ordinality
       )
       OR index_nulls_first <> ARRAY(
         SELECT expected_direction.value::boolean
         FROM jsonb_array_elements_text(spec->'descending') WITH ORDINALITY AS expected_direction(value, ordinality)
         ORDER BY expected_direction.ordinality
       ) THEN
      RAISE EXCEPTION 'index public.% definition mismatch', spec->>'name';
    END IF;
  END LOOP;

  SELECT
    access_method.amname,
    index_row.indisunique,
    array_agg(attribute_row.attname::text ORDER BY index_key.ordinality),
    array_agg((index_row.indoption[index_key.ordinality::integer - 1] & 1) = 1 ORDER BY index_key.ordinality),
    array_agg((index_row.indoption[index_key.ordinality::integer - 1] & 2) = 2 ORDER BY index_key.ordinality),
    index_row.indisvalid,
    index_row.indisready,
    index_row.indislive,
    bool_and(index_row.indcollation[index_key.ordinality::integer - 1] = attribute_row.attcollation),
    bool_and(opclass_row.opcdefault),
    pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
  INTO
    index_method,
    index_unique,
    index_columns,
    index_descending,
    index_nulls_first,
    index_valid,
    index_ready,
    index_live,
    index_column_collations,
    index_default_opclasses,
    actual_definition
  FROM pg_catalog.pg_index index_row
  JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
  JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam
  CROSS JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY AS index_key(attnum, ordinality)
  JOIN pg_catalog.pg_attribute attribute_row
    ON attribute_row.attrelid = index_row.indrelid
   AND attribute_row.attnum = index_key.attnum
  JOIN pg_catalog.pg_opclass opclass_row
    ON opclass_row.oid = index_row.indclass[index_key.ordinality::integer - 1]
   AND opclass_row.opcmethod = index_relation.relam
  WHERE index_row.indrelid = 'public.chat_conversations'::regclass
    AND index_relation.relname = 'UQ_chat_conversations_open_customer_area'
    AND index_row.indpred IS NOT NULL
    AND index_row.indexprs IS NULL
    AND index_row.indnkeyatts = 2
    AND index_row.indnatts = 2
  GROUP BY
    access_method.amname,
    index_row.indisunique,
    index_row.indisvalid,
    index_row.indisready,
    index_row.indislive,
    index_row.indpred,
    index_row.indrelid;

  normalized_actual := regexp_replace(
    regexp_replace(
      lower(COALESCE(actual_definition, '')),
      '::(public\.)?chat_conversations_status_enum', '', 'g'
    ),
    '[\s()"\[\]]', '', 'g'
  );
  IF NOT FOUND
     OR index_method <> 'btree'
     OR NOT index_unique
     OR NOT index_valid
     OR NOT index_ready
     OR NOT index_live
     OR NOT index_column_collations
     OR NOT index_default_opclasses
     OR index_columns <> ARRAY['customerUserId', 'area']
     OR index_descending <> ARRAY[false, false]
     OR index_nulls_first <> ARRAY[false, false]
     OR normalized_actual <> 'status=anyarray''open_unassigned'',''open_assigned''' THEN
    RAISE EXCEPTION 'index public.UQ_chat_conversations_open_customer_area definition mismatch';
  END IF;
END
$strict_relational_verification$;

COMMIT;

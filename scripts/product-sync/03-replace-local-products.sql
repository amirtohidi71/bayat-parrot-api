\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  transfer_count integer;
  local_target_count integer;
  actual_skus text[];
  local_target_skus text[];
  expected_skus text[];
  invalid_text_skus text[];
  foreign_key record;
  dependency_exists boolean;
BEGIN
  SELECT ARRAY_AGG('BP14050427' || TO_CHAR(number, 'FM0000') ORDER BY number)
  INTO expected_skus
  FROM GENERATE_SERIES(1, 18) AS series(number);

  SELECT COUNT(*), ARRAY_AGG("sku" ORDER BY "sku")
  INTO transfer_count, actual_skus
  FROM public.product_transfer_18;

  IF transfer_count <> 18 THEN
    RAISE EXCEPTION 'Expected exactly 18 transfer rows, found %', transfer_count;
  END IF;

  IF actual_skus IS DISTINCT FROM expected_skus THEN
    RAISE EXCEPTION 'Transfer SKU set does not exactly match BP140504270001 through BP140504270018';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_transfer_18
    WHERE COALESCE(BTRIM("name"), '') = ''
  ) THEN
    RAISE EXCEPTION 'One or more transfer products have an empty name';
  END IF;

  SELECT ARRAY_AGG("sku" ORDER BY "sku")
  INTO invalid_text_skus
  FROM public.product_transfer_18
  WHERE POSITION(
      '????' IN CONCAT_WS(' ',
        "sku", "name", "description", "shortDescription", "lastEditedByName",
        "subCategory", "species", "subspecies", "brand", "weight", "productType",
        "size", "material", "status"::text, "categorySlug"::text, "gender"::text,
        "ageStage"::text, "specifications"::text, "colorVariants"::text,
        "colors"::text, "images"::text
      )
    ) > 0
    OR POSITION(
      CHR(65533) IN CONCAT_WS(' ',
        "sku", "name", "description", "shortDescription", "lastEditedByName",
        "subCategory", "species", "subspecies", "brand", "weight", "productType",
        "size", "material", "status"::text, "categorySlug"::text, "gender"::text,
        "ageStage"::text, "specifications"::text, "colorVariants"::text,
        "colors"::text, "images"::text
      )
    ) > 0;

  IF invalid_text_skus IS NOT NULL THEN
    RAISE EXCEPTION 'Corrupted text detected in transfer products: %', invalid_text_skus;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_transfer_18
    WHERE "status"::text <> 'published' OR "deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'All transfer products must be published and have deletedAt = NULL';
  END IF;

  SELECT COUNT(*), ARRAY_AGG("sku" ORDER BY "sku")
  INTO local_target_count, local_target_skus
  FROM public.products
  WHERE "sku" LIKE 'BP14050427%';

  IF local_target_count <> 18 THEN
    RAISE EXCEPTION 'Expected exactly 18 existing Local target products, found %', local_target_count;
  END IF;

  IF local_target_skus IS DISTINCT FROM expected_skus THEN
    RAISE EXCEPTION 'Existing Local SKU set does not exactly match BP140504270001 through BP140504270018';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.products
    WHERE "sku" LIKE 'BP14050427%'
      AND "deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Every existing Local target product must be soft-deleted before replacement';
  END IF;

  -- These are the two product relations currently declared by the TypeORM entities.
  IF EXISTS (
    SELECT 1
    FROM public.order_items AS order_item
    JOIN public.products AS target_product
      ON target_product."id" = order_item."productId"
    WHERE target_product."sku" LIKE 'BP14050427%'
  ) THEN
    RAISE EXCEPTION 'Target products are referenced by order_items';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_reviews AS product_review
    JOIN public.products AS target_product
      ON target_product."id" = product_review."productId"
    WHERE target_product."sku" LIKE 'BP14050427%'
  ) THEN
    RAISE EXCEPTION 'Target products are referenced by product_reviews';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'public.products'::regclass
      AND (ARRAY_LENGTH(conkey, 1) <> 1 OR ARRAY_LENGTH(confkey, 1) <> 1)
  ) THEN
    RAISE EXCEPTION 'Composite foreign key referencing products detected; manual dependency review required';
  END IF;

  FOR foreign_key IN
    SELECT
      constraint_row.conname AS constraint_name,
      constraint_row.conrelid::regclass AS child_table,
      child_attribute.attname AS child_column,
      parent_attribute.attname AS parent_column
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_attribute AS child_attribute
      ON child_attribute.attrelid = constraint_row.conrelid
     AND child_attribute.attnum = constraint_row.conkey[1]
    JOIN pg_catalog.pg_attribute AS parent_attribute
      ON parent_attribute.attrelid = constraint_row.confrelid
     AND parent_attribute.attnum = constraint_row.confkey[1]
    WHERE constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'public.products'::regclass
  LOOP
    EXECUTE FORMAT(
      'SELECT EXISTS (
         SELECT 1
         FROM %s AS child_row
         JOIN public.products AS target_product
           ON child_row.%I = target_product.%I
         WHERE target_product."sku" LIKE $1
       )',
      foreign_key.child_table,
      foreign_key.child_column,
      foreign_key.parent_column
    )
    INTO dependency_exists
    USING 'BP14050427%';

    IF dependency_exists THEN
      RAISE EXCEPTION 'Target products are referenced by table % through constraint %',
        foreign_key.child_table,
        foreign_key.constraint_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.products AS holder_product
    JOIN public.products AS target_product
      ON target_product."id" = ANY(COALESCE(holder_product."boughtTogetherProductIds", ARRAY[]::uuid[]))
    WHERE target_product."sku" LIKE 'BP14050427%'
      AND (holder_product."sku" IS NULL OR holder_product."sku" NOT LIKE 'BP14050427%')
  ) THEN
    RAISE EXCEPTION 'A non-target product references a target ID in boughtTogetherProductIds';
  END IF;
END
$$;

DO $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.products
  WHERE "sku" LIKE 'BP14050427%';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  IF deleted_count <> 18 THEN
    RAISE EXCEPTION 'Expected to hard-delete exactly 18 Local products, deleted %', deleted_count;
  END IF;
END
$$;

INSERT INTO public.products (
  "id",
  "sku",
  "name",
  "description",
  "shortDescription",
  "specifications",
  "boughtTogetherProductIds",
  "lastEditedByName",
  "price",
  "discountPercent",
  "discountPrice",
  "stock",
  "colorVariants",
  "status",
  "categorySlug",
  "subCategory",
  "species",
  "subspecies",
  "gender",
  "ageStage",
  "colors",
  "brand",
  "weight",
  "productType",
  "size",
  "material",
  "tagPair",
  "tagHandTame",
  "tagCustom",
  "tagLuxury",
  "tagHealthGuarantee",
  "tagFastShipping",
  "tagFreeShipping",
  "tagCarryCage",
  "isAmazingOffer",
  "amazingOfferEndsAt",
  "images",
  "createdAt",
  "updatedAt",
  "deletedAt"
)
SELECT
  "id",
  "sku",
  "name",
  "description",
  "shortDescription",
  "specifications",
  "boughtTogetherProductIds",
  "lastEditedByName",
  "price",
  "discountPercent",
  "discountPrice",
  "stock",
  "colorVariants",
  "status",
  "categorySlug",
  "subCategory",
  "species",
  "subspecies",
  "gender",
  "ageStage",
  "colors",
  "brand",
  "weight",
  "productType",
  "size",
  "material",
  "tagPair",
  "tagHandTame",
  "tagCustom",
  "tagLuxury",
  "tagHealthGuarantee",
  "tagFastShipping",
  "tagFreeShipping",
  "tagCarryCage",
  "isAmazingOffer",
  "amazingOfferEndsAt",
  "images",
  "createdAt",
  "updatedAt",
  "deletedAt"
FROM public.product_transfer_18
ORDER BY "sku";

DO $$
DECLARE
  active_count integer;
  total_count integer;
  soft_deleted_count integer;
  active_published_count integer;
  active_pending_count integer;
  active_draft_count integer;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL),
    COUNT(*),
    COUNT(*) FILTER (WHERE "deletedAt" IS NOT NULL),
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND "status"::text = 'published'),
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND "status"::text = 'pending'),
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND "status"::text = 'draft')
  INTO
    active_count,
    total_count,
    soft_deleted_count,
    active_published_count,
    active_pending_count,
    active_draft_count
  FROM public.products;

  IF active_count <> 30
    OR total_count <> 33
    OR soft_deleted_count <> 3
    OR active_published_count <> 30
    OR active_pending_count <> 0
    OR active_draft_count <> 0
  THEN
    RAISE EXCEPTION
      'Final counts invalid: active=%, total=%, softDeleted=%, published=%, pending=%, draft=%',
      active_count,
      total_count,
      soft_deleted_count,
      active_published_count,
      active_pending_count,
      active_draft_count;
  END IF;
END
$$;

COMMIT;

-- This runs only after a successful commit because ON_ERROR_STOP is enabled.
DROP TABLE public.product_transfer_18;

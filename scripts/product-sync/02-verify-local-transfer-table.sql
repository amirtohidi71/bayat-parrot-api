\set ON_ERROR_STOP on

-- Run on Local after restoring product_transfer_18 from the custom-format dump.
-- Example (connection details must come from the operator's environment):
--   pg_restore --dbname="$LOCAL_DATABASE_URL" --no-owner --no-privileges product_transfer_18.dump

DO $$
DECLARE
  matched_count integer;
  actual_skus text[];
  expected_skus text[];
  invalid_text_skus text[];
BEGIN
  SELECT ARRAY_AGG('BP14050427' || TO_CHAR(number, 'FM0000') ORDER BY number)
  INTO expected_skus
  FROM GENERATE_SERIES(1, 18) AS series(number);

  SELECT COUNT(*), ARRAY_AGG("sku" ORDER BY "sku")
  INTO matched_count, actual_skus
  FROM public.product_transfer_18;

  IF matched_count <> 18 THEN
    RAISE EXCEPTION 'Expected exactly 18 transfer rows, found %', matched_count;
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
END
$$;

SELECT COUNT(*) AS "verifiedTransferCount"
FROM public.product_transfer_18;

SELECT "sku", "name", "status", "deletedAt"
FROM public.product_transfer_18
ORDER BY "sku";

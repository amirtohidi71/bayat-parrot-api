\set ON_ERROR_STOP on

-- Run on Production before creating the custom-format dump.
-- Example (connection details must come from the operator's environment):
--   pg_dump --format=custom --table=public.product_transfer_18 --file=product_transfer_18.dump "$PRODUCTION_DATABASE_URL"

BEGIN;

DO $$
DECLARE
  matched_count integer;
  actual_skus text[];
  expected_skus text[];
BEGIN
  SELECT ARRAY_AGG('BP14050427' || TO_CHAR(number, 'FM0000') ORDER BY number)
  INTO expected_skus
  FROM GENERATE_SERIES(1, 18) AS series(number);

  SELECT COUNT(*), ARRAY_AGG("sku" ORDER BY "sku")
  INTO matched_count, actual_skus
  FROM public.products
  WHERE "sku" LIKE 'BP14050427%';

  IF matched_count <> 18 THEN
    RAISE EXCEPTION 'Expected exactly 18 Production products, found %', matched_count;
  END IF;

  IF actual_skus IS DISTINCT FROM expected_skus THEN
    RAISE EXCEPTION 'Production SKU set does not exactly match BP140504270001 through BP140504270018';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.products
    WHERE "sku" LIKE 'BP14050427%'
      AND ("deletedAt" IS NOT NULL OR "status"::text <> 'published')
  ) THEN
    RAISE EXCEPTION 'All 18 Production products must be published and not soft-deleted';
  END IF;
END
$$;

DROP TABLE IF EXISTS public.product_transfer_18;
CREATE TABLE public.product_transfer_18 (LIKE public.products INCLUDING ALL);

INSERT INTO public.product_transfer_18 (
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
FROM public.products
WHERE "sku" LIKE 'BP14050427%'
ORDER BY "sku";

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.product_transfer_18) <> 18 THEN
    RAISE EXCEPTION 'Transfer table was not populated with exactly 18 rows';
  END IF;
END
$$;

COMMIT;

SELECT COUNT(*) AS "transferCount"
FROM public.product_transfer_18;

SELECT "sku"
FROM public.product_transfer_18
ORDER BY "sku";

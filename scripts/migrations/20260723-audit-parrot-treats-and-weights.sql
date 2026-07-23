BEGIN TRANSACTION READ ONLY;

-- This audit deliberately uses categorySlug::text so it can run before or
-- after the parrot-treats enum migration. Raw SQL includes every status and
-- rows with a deletion timestamp; no TypeORM default visibility filter applies.
WITH audited_products AS MATERIALIZED (
  SELECT
    product.id,
    product.sku,
    product.name,
    product."categorySlug"::text AS "categorySlug",
    product."subCategory",
    product.weight,
    product."productType",
    product.status::text AS status,
    product."deletedAt",
    CASE
      WHEN product."categorySlug"::text = 'parrot-accessories'
        AND (
          product."subCategory" = 'bedding'
          OR product.name ILIKE '%پلت بستر%'
        )
        THEN 'exclude-bedding-pellet'
      WHEN product."categorySlug"::text = 'parrot-serlak'
        THEN 'serlak'
      WHEN product."categorySlug"::text = 'parrot-treats'
        THEN 'parrot-treat'
      WHEN product."subCategory" IN (
        'pellet',
        'omega-pellet',
        'protein-pellets',
        'energy-pellets',
        'fruit-pellet'
      )
        THEN 'pellet-subcategory-candidate'
      WHEN concat_ws(
        ' ',
        product.name,
        product.description,
        product."shortDescription",
        product."productType",
        product."subCategory"
      ) ILIKE ANY (ARRAY['%پلت%', '%pellet%'])
        THEN 'pellet-text-candidate'
      WHEN product.weight IN ('1kg', '3kg', '5kg', '10kg')
        THEN 'legacy-weight'
      ELSE 'other-audit-match'
    END AS audit_classification
  FROM products product
  WHERE product."categorySlug"::text IN (
      'parrot-serlak',
      'parrot-treats'
    )
    OR product."subCategory" IN (
      'pellet',
      'omega-pellet',
      'protein-pellets',
      'energy-pellets',
      'fruit-pellet',
      'bedding'
    )
    OR concat_ws(
      ' ',
      product.name,
      product.description,
      product."shortDescription",
      product."productType",
      product."subCategory"
    ) ILIKE ANY (ARRAY['%سرلاک%', '%پلت%', '%pellet%'])
    OR product.weight IN ('1kg', '3kg', '5kg', '10kg')
)
SELECT
  audit_classification,
  id,
  sku,
  name,
  "categorySlug",
  "subCategory",
  weight,
  "productType",
  status,
  "deletedAt"
FROM audited_products
ORDER BY
  audit_classification,
  "deletedAt" NULLS FIRST,
  "categorySlug",
  sku;

-- Summary includes all statuses and reports active versus soft-deleted rows.
WITH audited_products AS (
  SELECT
    product.status::text AS status,
    product."deletedAt",
    CASE
      WHEN product."categorySlug"::text = 'parrot-accessories'
        AND (
          product."subCategory" = 'bedding'
          OR product.name ILIKE '%پلت بستر%'
        )
        THEN 'exclude-bedding-pellet'
      WHEN product."categorySlug"::text = 'parrot-serlak'
        THEN 'serlak'
      WHEN product."categorySlug"::text = 'parrot-treats'
        THEN 'parrot-treat'
      WHEN product."subCategory" IN (
        'pellet',
        'omega-pellet',
        'protein-pellets',
        'energy-pellets',
        'fruit-pellet'
      )
        THEN 'pellet-subcategory-candidate'
      ELSE 'pellet-or-legacy-candidate'
    END AS audit_classification
  FROM products product
  WHERE product."categorySlug"::text IN ('parrot-serlak', 'parrot-treats')
    OR product."subCategory" IN (
      'pellet',
      'omega-pellet',
      'protein-pellets',
      'energy-pellets',
      'fruit-pellet',
      'bedding'
    )
    OR concat_ws(
      ' ',
      product.name,
      product.description,
      product."shortDescription",
      product."productType",
      product."subCategory"
    ) ILIKE ANY (ARRAY['%سرلاک%', '%پلت%', '%pellet%'])
    OR product.weight IN ('1kg', '3kg', '5kg', '10kg')
)
SELECT
  audit_classification,
  status,
  COUNT(*) FILTER (WHERE "deletedAt" IS NULL) AS active_count,
  COUNT(*) FILTER (WHERE "deletedAt" IS NOT NULL) AS soft_deleted_count,
  COUNT(*) AS total_count
FROM audited_products
GROUP BY audit_classification, status
ORDER BY audit_classification, status;

-- Keep bedding pellets visibly separate: these are accessories and must not be
-- reclassified as edible pellet products in a later data migration.
SELECT
  product.id,
  product.sku,
  product.name,
  product."categorySlug"::text AS "categorySlug",
  product."subCategory",
  product.weight,
  product.status::text AS status,
  product."deletedAt"
FROM products product
WHERE product."categorySlug"::text = 'parrot-accessories'
  AND (
    product."subCategory" = 'bedding'
    OR product.name ILIKE '%پلت بستر%'
  )
ORDER BY product."deletedAt" NULLS FIRST, product.sku;

ROLLBACK;

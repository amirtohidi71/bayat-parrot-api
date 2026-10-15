import { EntityManager } from 'typeorm';

// PostgreSQL converts local Tehran midnights back to UTC instants. The end is
// exclusive, so Friday's final fractional second remains inside the week.
const TEHRAN_WEEK_BOUNDS_SQL = `WITH tehran_clock AS (
  SELECT COALESCE($1::timestamptz, CURRENT_TIMESTAMP)
    AT TIME ZONE 'Asia/Tehran' AS local_time
), week_start AS (
  SELECT date_trunc('day', local_time)
    - ((extract(isodow FROM local_time)::integer + 1) % 7)
      * interval '1 day' AS local_start
  FROM tehran_clock
)
SELECT local_start AT TIME ZONE 'Asia/Tehran' AS "weekStart",
       (local_start + interval '7 days') AT TIME ZONE 'Asia/Tehran' AS "weekEnd"
FROM week_start`;

export async function tehranWeekBounds(
  manager: EntityManager,
  instant?: Date,
): Promise<{ start: Date; end: Date }> {
  const [week] = await manager.query<Array<{ weekStart: Date; weekEnd: Date }>>(
    TEHRAN_WEEK_BOUNDS_SQL,
    [instant ?? null],
  );
  if (
    !week ||
    !(week.weekStart instanceof Date) ||
    !(week.weekEnd instanceof Date)
  )
    throw new Error('Tehran week boundaries are unavailable');
  return { start: week.weekStart, end: week.weekEnd };
}

/**
 * Seeds (or re-seeds) the providers table from SEED_PROVIDERS.
 * Idempotent: rows are upserted by primary key, so running it twice is safe.
 *
 *   npm run db:seed   (node --env-file-if-exists=.env --import tsx src/server/db/seed.ts)
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db/client";
import { providers } from "@/server/db/schema";
import { SEED_PROVIDERS } from "@/server/db/seed-data";

async function main(): Promise<void> {
  const db = getDb();
  const rows = SEED_PROVIDERS.map((p) => ({
    id: p.id,
    kind: p.kind,
    parentProviderId: p.parentProviderId,
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    specialties: p.specialties,
    city: p.city,
    country: p.country,
    languages: p.languages,
    emergencyCapable: p.emergencyCapable,
    telemedicine: p.telemedicine,
    acceptsInternational: p.acceptsInternational,
    rating: p.rating,
    priceTier: p.priceTier,
    accreditations: p.accreditations,
    descriptionEn: p.descriptionEn,
    descriptionAr: p.descriptionAr,
    isActive: p.isActive,
  }));

  await db
    .insert(providers)
    .values(rows)
    .onConflictDoUpdate({
      target: providers.id,
      set: {
        kind: sql`excluded.kind`,
        parentProviderId: sql`excluded.parent_provider_id`,
        nameEn: sql`excluded.name_en`,
        nameAr: sql`excluded.name_ar`,
        specialties: sql`excluded.specialties`,
        city: sql`excluded.city`,
        country: sql`excluded.country`,
        languages: sql`excluded.languages`,
        emergencyCapable: sql`excluded.emergency_capable`,
        telemedicine: sql`excluded.telemedicine`,
        acceptsInternational: sql`excluded.accepts_international`,
        rating: sql`excluded.rating`,
        priceTier: sql`excluded.price_tier`,
        accreditations: sql`excluded.accreditations`,
        descriptionEn: sql`excluded.description_en`,
        descriptionAr: sql`excluded.description_ar`,
        isActive: sql`excluded.is_active`,
      },
    });

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(providers);
  console.info(`Seeded ${rows.length} providers; table now holds ${count} rows.`);
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    // Drizzle wraps driver errors and embeds the full query + params in
    // `message`; the driver's own message (the cause) is the useful part.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    console.error("Seed failed:", cause instanceof Error ? cause.message : String(cause));
    await closeDb().catch(() => undefined);
    process.exit(1);
  });

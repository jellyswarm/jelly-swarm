import { Column, type PricebookKey } from "@jelly/engine";
import { Product, Tier } from "@jelly/shared";
import { z } from "zod";

/**
 * §11.3 "Storage. Templates are TypeScript files ... Each file exports"
 * `defineTemplate({...})`. A template fixes the columns, the tier, the
 * safety class and the pricebook entry; the caller only ever supplies
 * `params` (typically the item list).
 */
export const SafetyClass = z.enum(["public", "crypto-readonly", "private"]);
export type SafetyClass = z.infer<typeof SafetyClass>;

export type TemplateDef<P = unknown> = {
  slug: string;
  product: Product;
  title: string;
  params: z.ZodType<P>;
  columns: Column[];
  defaultTier: Tier;
  safetyClass: SafetyClass;
  example: P;
  pricebookKey: PricebookKey;
  /** Builds the job's task text and item list from validated params. */
  build: (params: P) => { task: string; items: string[] };
};

const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export class TemplateDefinitionError extends Error {}

/** Validates the shape at definition time, not only when a job is built from it, so a bad template fails to load rather than fails mysteriously later. */
export function defineTemplate<P>(def: TemplateDef<P>): TemplateDef<P> {
  if (!SLUG.test(def.slug)) throw new TemplateDefinitionError(`bad slug: ${def.slug}`);
  if (def.columns.length === 0) throw new TemplateDefinitionError(`${def.slug}: needs at least one column`);
  const names = new Set<string>();
  for (const c of def.columns) {
    const key = c.name.toLowerCase();
    if (names.has(key)) throw new TemplateDefinitionError(`${def.slug}: duplicate column ${c.name}`);
    names.add(key);
  }
  const parsedExample = def.params.safeParse(def.example);
  if (!parsedExample.success) throw new TemplateDefinitionError(`${def.slug}: its own example does not satisfy its params schema`);
  return Object.freeze({ ...def, columns: Object.freeze([...def.columns]) }) as TemplateDef<P>;
}

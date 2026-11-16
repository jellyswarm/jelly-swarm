import type { TemplateDef } from "./define";

export type TemplateVersion = { slug: string; version: number; def: TemplateDef<unknown> };
export type TemplateSummary = { slug: string; title: string; product: string; currentVersion: number; status: "active" | "hidden" };

/**
 * §11.3 "Bumping a version never changes a running job. A rerun uses the
 * template's current version, and the change is shown on the quote." So a
 * registry must keep every past version addressable by number, forever,
 * even after the slug has moved on to a newer one.
 */
export interface TemplateRegistry {
  /**
   * Registers slug at version 1. Refuses if the slug already exists; use
   * `bump` for a new version. Generic only so a caller's own concretely-typed
   * `TemplateDef<P>` (from `defineTemplate`) can be passed directly; once
   * stored, every lookup returns the erased `TemplateDef<unknown>`.
   */
  register<P>(def: TemplateDef<P>): Promise<void>;
  /** Registers a new version of an existing slug. Returns the new version number. */
  bump<P>(def: TemplateDef<P>): Promise<number>;
  /** The current (latest) version of a slug. */
  current(slug: string): Promise<TemplateVersion | undefined>;
  /** One specific version, e.g. to rebuild a job exactly as an old rerun saw it. */
  version(slug: string, version: number): Promise<TemplateVersion | undefined>;
  list(): Promise<TemplateSummary[]>;
  hide(slug: string): Promise<void>;
}

export class TemplateRegistryError extends Error {}

export class MemoryTemplateRegistry implements TemplateRegistry {
  private readonly versions = new Map<string, TemplateDef<unknown>[]>(); // index 0 = version 1
  private readonly hidden = new Set<string>();

  async register<P>(def: TemplateDef<P>): Promise<void> {
    if (this.versions.has(def.slug)) throw new TemplateRegistryError(`template already registered: ${def.slug}`);
    this.versions.set(def.slug, [def as TemplateDef<unknown>]);
  }

  async bump<P>(def: TemplateDef<P>): Promise<number> {
    const list = this.versions.get(def.slug);
    if (!list) throw new TemplateRegistryError(`unknown template: ${def.slug}; register it first`);
    list.push(def as TemplateDef<unknown>);
    return list.length;
  }

  async current(slug: string): Promise<TemplateVersion | undefined> {
    const list = this.versions.get(slug);
    return list ? { slug, version: list.length, def: list[list.length - 1]! } : undefined;
  }

  async version(slug: string, version: number): Promise<TemplateVersion | undefined> {
    const list = this.versions.get(slug);
    const def = list?.[version - 1];
    return def ? { slug, version, def } : undefined;
  }

  async list(): Promise<TemplateSummary[]> {
    return [...this.versions.entries()]
      .filter(([slug]) => !this.hidden.has(slug))
      .map(([slug, list]) => {
        const def = list[list.length - 1]!;
        return { slug, title: def.title, product: def.product, currentVersion: list.length, status: "active" as const };
      });
  }

  async hide(slug: string): Promise<void> {
    this.hidden.add(slug);
  }
}

/** Whether `usedVersion` of `slug` is still the current one; false (and the gap) if the slug has moved on, or vanished. */
export async function versionDrift(registry: TemplateRegistry, slug: string, usedVersion: number): Promise<{ current: boolean; latest?: number }> {
  const latest = await registry.current(slug);
  if (!latest) return { current: false };
  return { current: latest.version === usedVersion, latest: latest.version };
}

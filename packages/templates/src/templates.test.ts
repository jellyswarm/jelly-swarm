import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  MemoryTemplateRegistry,
  PRICE_COMPARE,
  RESEARCH_REPORT,
  TOKEN_DD_SWEEP,
  TemplateDefinitionError,
  TemplateRegistryError,
  V1_GALLERY,
  WALLET_AIRDROP_SWEEP,
  defineTemplate,
  versionDrift,
} from "./index";

describe("defineTemplate (§11.3)", () => {
  test("the v1 gallery templates all load, build real items, and are frozen", () => {
    for (const t of V1_GALLERY) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(t.params.safeParse(t.example).success).toBe(true);
    }
    expect(TOKEN_DD_SWEEP.build({ items: ["0xabc", "0xabc", " "] }).items).toEqual(["0xabc"]);
    expect(RESEARCH_REPORT.build({ topic: "x", questions: ["q1", "q2"] }).items).toEqual(["q1", "q2"]);
  });

  test("rejects a bad slug, duplicate columns, or an example that fails its own params schema", () => {
    const base = { ...TOKEN_DD_SWEEP };
    expect(() => defineTemplate({ ...base, slug: "Not Ok" })).toThrow(TemplateDefinitionError);
    expect(() => defineTemplate({ ...base, columns: [...base.columns, { name: "Holders", type: "text", needsSource: false }] })).toThrow(
      TemplateDefinitionError,
    );
    expect(() => defineTemplate({ ...base, example: { items: [] } })).toThrow(TemplateDefinitionError); // min(1) violated
    expect(() => defineTemplate({ ...base, columns: [] })).toThrow(TemplateDefinitionError);
  });
});

describe("MemoryTemplateRegistry: versioning and rerun (§11.3, §11.4)", () => {
  test("registering twice, or bumping an unknown slug, is refused", async () => {
    const registry = new MemoryTemplateRegistry();
    await registry.register(TOKEN_DD_SWEEP);
    await expect(registry.register(TOKEN_DD_SWEEP)).rejects.toThrow(TemplateRegistryError);
    await expect(registry.bump(RESEARCH_REPORT)).rejects.toThrow(TemplateRegistryError);
  });

  test("bumping a version never changes what a running job sees: old versions stay addressable", async () => {
    const registry = new MemoryTemplateRegistry();
    await registry.register(TOKEN_DD_SWEEP);
    const v2 = defineTemplate({ ...TOKEN_DD_SWEEP, columns: [...TOKEN_DD_SWEEP.columns, { name: "chain", type: "text", needsSource: false }] });
    expect(await registry.bump(v2)).toBe(2);

    expect((await registry.version(TOKEN_DD_SWEEP.slug, 1))!.def.columns).toHaveLength(3);
    expect((await registry.version(TOKEN_DD_SWEEP.slug, 2))!.def.columns).toHaveLength(4);
    expect((await registry.current(TOKEN_DD_SWEEP.slug))!.version).toBe(2);
  });

  test("a rerun pinned to an old version sees the version drift so the UI can disclose it", async () => {
    const registry = new MemoryTemplateRegistry();
    await registry.register(PRICE_COMPARE);
    expect(await versionDrift(registry, PRICE_COMPARE.slug, 1)).toEqual({ current: true, latest: 1 });

    await registry.bump(defineTemplate({ ...PRICE_COMPARE, title: "Compare prices (v2)" }));
    expect(await versionDrift(registry, PRICE_COMPARE.slug, 1)).toEqual({ current: false, latest: 2 });
    expect(await versionDrift(registry, PRICE_COMPARE.slug, 2)).toEqual({ current: true, latest: 2 });
    expect(await versionDrift(registry, "no-such-slug", 1)).toEqual({ current: false });
  });

  test("the gallery lists active templates with their current version, and a hidden one drops out", async () => {
    const registry = new MemoryTemplateRegistry();
    for (const t of V1_GALLERY) await registry.register(t);
    expect(await registry.list()).toHaveLength(V1_GALLERY.length);
    await registry.hide(WALLET_AIRDROP_SWEEP.slug);
    const list = await registry.list();
    expect(list).toHaveLength(V1_GALLERY.length - 1);
    expect(list.some((t) => t.slug === WALLET_AIRDROP_SWEEP.slug)).toBe(false);
    expect(list.find((t) => t.slug === TOKEN_DD_SWEEP.slug)).toMatchObject({ currentVersion: 1, status: "active" });
  });

  test("a wallet-sweep template is marked private and forces the Sealed tier", () => {
    expect(WALLET_AIRDROP_SWEEP).toMatchObject({ safetyClass: "private", defaultTier: "sealed" });
  });

  test("params validation catches a bad caller input before a job would ever be built", () => {
    expect(() => TOKEN_DD_SWEEP.params.parse({ items: [] })).toThrow();
    expect(() => z.object({ items: z.array(z.string()).max(247) }).parse(WALLET_AIRDROP_SWEEP.example)).not.toThrow();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import request from "supertest";
import { app } from "../src/app";

const originalApiKey = process.env.MASTER_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.MASTER_API_KEY;
  else process.env.MASTER_API_KEY = originalApiKey;
});

describe("API key gate", () => {
  test("health remains public", async () => {
    delete process.env.MASTER_API_KEY;
    const response = await request(app).get("/health/");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  test("non-health requests fail closed when the key is missing", async () => {
    delete process.env.MASTER_API_KEY;
    const response = await request(app).get("/jobs");
    expect(response.status).toBe(503);
    expect(response.body.error).toBe("api_key_not_configured");
  });

  test("non-health requests reject missing or wrong keys", async () => {
    process.env.MASTER_API_KEY = "test-master-key";
    const missing = await request(app).get("/jobs");
    const wrong = await request(app).get("/jobs").set("x-api-key", "wrong-key");
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  test("valid key reaches API routes", async () => {
    process.env.MASTER_API_KEY = "test-master-key";
    const response = await request(app).get("/not-found").set("x-api-key", "test-master-key");
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("not_found");
  });
});

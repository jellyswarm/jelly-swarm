import { describe, expect, test } from "bun:test";
import request from "supertest";
import { app } from "../src/app";

describe("GET /health", () => {
  test("returns service status, timestamp and version", async () => {
    const response = await request(app).get("/health/");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.version).toBe("0.1.0");
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });
});

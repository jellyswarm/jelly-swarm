import express from "express";
import { healthRouter } from "./routes/health";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use("/health", healthRouter);
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

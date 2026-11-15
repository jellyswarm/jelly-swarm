import type { HostSpec } from "./hosts";
import type { ChatProvider, ChatRequest, ChatResponse } from "./provider";

export type MockHandler = (host: HostSpec, req: ChatRequest, callIndex: number) => ChatResponse | Promise<ChatResponse>;

/** A scripted provider for tests and local runs. Records every call it receives. */
export class MockProvider implements ChatProvider {
  readonly calls: { host: HostSpec; req: ChatRequest }[] = [];

  constructor(private handler: MockHandler = () => mockResponse()) {}

  setHandler(handler: MockHandler): void {
    this.handler = handler;
  }

  async chat(host: HostSpec, req: ChatRequest): Promise<ChatResponse> {
    const index = this.calls.length;
    this.calls.push({ host, req });
    return this.handler(host, req, index);
  }
}

export const mockResponse = (over: Partial<ChatResponse> = {}): ChatResponse => ({
  content: "ok",
  toolCalls: [],
  usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 },
  ...over,
});

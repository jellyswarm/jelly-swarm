import { type Envelope, renderDataBlock } from "./envelope";
import type { RawToolCall } from "./manifest";

/**
 * The only message shapes the engine can send to a model. There is no way to
 * express a second system message, and every piece of outside text is an
 * envelope.
 */
export type Message =
  | { role: "data"; envelopes: Envelope[] }
  | { role: "assistant"; content: string; toolCalls?: RawToolCall[] }
  | { role: "tool"; toolCallId: string; envelope: Envelope };

/** OpenAI-compatible wire messages. */
export type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export function toWire(messages: readonly Message[]): WireMessage[] {
  return messages.map((m): WireMessage => {
    switch (m.role) {
      case "data":
        return { role: "user", content: renderDataBlock(m.envelopes) };
      case "assistant":
        return m.toolCalls && m.toolCalls.length > 0
          ? {
              role: "assistant",
              content: m.content,
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : { role: "assistant", content: m.content };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: renderDataBlock([m.envelope]) };
    }
  });
}

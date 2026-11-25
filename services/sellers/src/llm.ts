export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One chat completion. `tokens` is what the provider reports as used (prompt + completion). */
export type Llm = (messages: ChatMessage[], maxTokens: number) => Promise<{ text: string; tokens: number }>;

/**
 * Any OpenAI-compatible chat endpoint: Ollama (`http://127.0.0.1:11434/v1`), Groq (`https://api.groq.com/openai/v1`),
 * Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`), OpenRouter and so on.
 */
export function openAiLlm(cfg: { baseUrl: string; model: string; apiKey?: string }): Llm {
  return async (messages, maxTokens) => {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens }),
    });
    if (!res.ok) throw new Error(`LLM answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { total_tokens?: number } };
    const text = body.choices[0]?.message.content ?? "";
    // Some providers omit usage; ~4 characters per token is close enough to meter by.
    const tokens = body.usage?.total_tokens ?? Math.ceil((JSON.stringify(messages).length + text.length) / 4);
    return { text, tokens };
  };
}

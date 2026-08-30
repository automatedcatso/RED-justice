/**
 * Minimal ambient declaration for the OPTIONAL `z-ai-web-dev-sdk` dependency
 * (v3.8 GLM provider bridge). The package is deliberately NOT a hard
 * dependency — RED Justice must boot on machines without it — so dynamic
 * `import('z-ai-web-dev-sdk')` sites type-check against this shape and fail
 * soft at runtime when the module is absent.
 */
declare module 'z-ai-web-dev-sdk' {
  export interface ZaiChatCompletionMessage {
    role: string
    content: string
  }
  export interface ZaiChatCompletionChoice {
    message?: { content?: string; reasoning_content?: string }
  }
  export interface ZaiChatCompletion {
    choices?: ZaiChatCompletionChoice[]
  }
  export interface ZaiChatCompletions {
    create(payload: Record<string, unknown>): Promise<ZaiChatCompletion>
  }
  export interface ZaiClient {
    chat: { completions: ZaiChatCompletions }
  }
  export default class ZAI {
    static create(): Promise<ZaiClient>
  }
}

/**
 * programmatic-tools.js — Global config for Anthropic programmatic tool calling
 *
 * Provides shared constants, helpers, and an AgentLoop utility for any agent-tool
 * that wants to use code_execution_20250825 to call tools programmatically.
 *
 * Usage:
 *   import { createClient, CODE_EXECUTION_TOOL, makeCallableTool, AgentLoop }
 *     from './lib/programmatic-tools.js';
 *
 *   const client = createClient();
 *   const tools = [
 *     CODE_EXECUTION_TOOL,
 *     makeCallableTool({
 *       name: 'search_web',
 *       description: 'Search the web. Returns JSON array of {title, url, text}.',
 *       input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
 *     }),
 *   ];
 *
 * Environment:
 *   ANTHROPIC_API_KEY — required for SDK usage (add to ~/.zshrc)
 */

import Anthropic from '@anthropic-ai/sdk';

// ── Constants ─────────────────────────────────────────────────────────────────

export const PROGRAMMATIC_MODEL = 'claude-sonnet-4-6';
export const PROGRAMMATIC_MODEL_HEAVY = 'claude-opus-4-6';
export const CODE_EXECUTION_VERSION = 'code_execution_20250825';

/**
 * The code execution tool definition. Always include this first in your tools array
 * when using programmatic tool calling.
 */
export const CODE_EXECUTION_TOOL = {
  type: CODE_EXECUTION_VERSION,
  name: 'code_execution',
};

// ── Client factory ─────────────────────────────────────────────────────────────

/**
 * Create an Anthropic client. Reads ANTHROPIC_API_KEY from env.
 * Throws early with a helpful message if the key is missing.
 */
export function createClient(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for programmatic tool calling.\n' +
      'Add to ~/.zshrc: export ANTHROPIC_API_KEY="sk-ant-..."'
    );
  }
  return new Anthropic({ apiKey: key });
}

// ── Tool helpers ───────────────────────────────────────────────────────────────

/**
 * Wrap a tool definition so it can only be called from code execution (not directly).
 * Use this for tools you want Claude to call programmatically inside the sandbox.
 *
 * @param {object} toolDef - Tool definition without allowed_callers
 * @returns {object} Tool definition with allowed_callers set
 */
export function makeCallableTool(toolDef) {
  return { ...toolDef, allowed_callers: [CODE_EXECUTION_VERSION] };
}

/**
 * Wrap a tool definition so it can be called both directly AND from code execution.
 * Use sparingly — prefer making tools exclusively callable from one context.
 */
export function makeHybridTool(toolDef) {
  return { ...toolDef, allowed_callers: ['direct', CODE_EXECUTION_VERSION] };
}

// ── Agent loop ─────────────────────────────────────────────────────────────────

/**
 * AgentLoop — manages the container lifecycle and turn-by-turn conversation
 * for a programmatic tool calling session.
 *
 * Example:
 *   const loop = new AgentLoop({
 *     client,
 *     tools,
 *     toolHandlers: { search_web: async ({ query }) => { ... } },
 *   });
 *   const result = await loop.run('Find the top 3 PM job postings at Stripe');
 *   console.log(result.text);
 */
export class AgentLoop {
  /**
   * @param {object} opts
   * @param {Anthropic} opts.client - Anthropic client
   * @param {object[]} opts.tools - Tools array (CODE_EXECUTION_TOOL + makeCallableTool entries)
   * @param {object} opts.toolHandlers - Map of tool name → async handler function
   * @param {string} [opts.model] - Model override (default: PROGRAMMATIC_MODEL)
   * @param {number} [opts.maxTokens] - Max output tokens (default: 8192)
   * @param {string} [opts.systemPrompt] - Optional system prompt
   * @param {boolean} [opts.verbose] - Log each turn to stderr
   */
  constructor(opts) {
    this.client = opts.client;
    this.tools = opts.tools;
    this.handlers = opts.toolHandlers || {};
    this.model = opts.model || PROGRAMMATIC_MODEL;
    this.maxTokens = opts.maxTokens || 8192;
    this.systemPrompt = opts.systemPrompt;
    this.verbose = opts.verbose || false;
    this.containerId = null;
  }

  log(...args) {
    if (this.verbose) console.error('[programmatic-tools]', ...args);
  }

  /**
   * Run a single user message through the agentic loop until stop_reason is 'end_turn'.
   * Returns { text, messages, containerId }.
   */
  async run(userMessage) {
    const messages = [{ role: 'user', content: userMessage }];
    let finalText = '';

    while (true) {
      const reqOpts = {
        model: this.model,
        max_tokens: this.maxTokens,
        tools: this.tools,
        messages,
      };
      if (this.systemPrompt) reqOpts.system = this.systemPrompt;
      if (this.containerId) reqOpts.container = this.containerId;

      this.log(`Calling API (container: ${this.containerId || 'new'})...`);
      const response = await this.client.messages.create(reqOpts);

      // Capture container ID for reuse
      if (response.container?.id && !this.containerId) {
        this.containerId = response.container.id;
        this.log(`Container: ${this.containerId} (expires: ${response.container.expires_at})`);
      }

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') {
        finalText = response.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        break;
      }

      if (response.stop_reason !== 'tool_use') {
        this.log(`Unexpected stop_reason: ${response.stop_reason}`);
        break;
      }

      // Respond to tool_use blocks (programmatic calls from code execution)
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const block of toolUseBlocks) {
        const handler = this.handlers[block.name];
        if (!handler) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: `No handler for tool: ${block.name}` }),
          });
          continue;
        }

        this.log(`Tool call: ${block.name}`, JSON.stringify(block.input).slice(0, 80));
        try {
          const result = await handler(block.input);
          const content = typeof result === 'string' ? result : JSON.stringify(result);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
          this.log(`  → ${content.slice(0, 80)}`);
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: err.message }),
          });
          this.log(`  → Error: ${err.message}`);
        }
      }

      if (toolResults.length > 0) {
        // IMPORTANT: when responding to programmatic tool calls, the message must contain
        // ONLY tool_result blocks — no text content allowed alongside them.
        messages.push({ role: 'user', content: toolResults });
      }
    }

    return { text: finalText, messages, containerId: this.containerId };
  }
}

// ── Standalone one-shot helper ─────────────────────────────────────────────────

/**
 * Quick one-shot: run a prompt with programmatic tools without managing a loop instance.
 *
 * @param {object} opts
 * @param {string} opts.prompt - User message
 * @param {object[]} opts.callableTools - Tool defs (auto-wrapped with makeCallableTool if needed)
 * @param {object} opts.toolHandlers - Map of tool name → async handler
 * @param {string} [opts.model]
 * @param {string} [opts.systemPrompt]
 * @param {boolean} [opts.verbose]
 * @returns {Promise<string>} Final text response
 */
export async function runWithTools(opts) {
  const client = createClient();
  const tools = [
    CODE_EXECUTION_TOOL,
    ...opts.callableTools.map(t =>
      t.allowed_callers ? t : makeCallableTool(t)
    ),
  ];

  const loop = new AgentLoop({
    client,
    tools,
    toolHandlers: opts.toolHandlers,
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    verbose: opts.verbose,
  });

  const { text } = await loop.run(opts.prompt);
  return text;
}

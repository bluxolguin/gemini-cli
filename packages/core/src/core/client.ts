/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EmbedContentParameters,
  GenerateContentConfig,
  Part,
  SchemaUnion,
  Content,
  Tool,
  GenerateContentResponse,
} from '@google/genai';
import { getFolderStructure } from '../utils/getFolderStructure.js';
import {
  Turn,
  ServerGeminiStreamEvent,
  GeminiEventType,
  ChatCompressionInfo,
} from './turn.js';
import { Config } from '../config/config.js';
import { getCoreSystemPrompt, getCompressionPrompt } from './prompts.js';
import { ReadManyFilesTool } from '../tools/read-many-files.js';
import { getResponseText }mport { checkNextSpeaker } from '../utils/nextSpeakerChecker.js';
import { reportError } from '../utils/errorReporting.js';
import { GeminiChat } from './geminiChat.js';
import { retryWithBackoff } from '../utils/retry.js';
import { getErrorMessage } from '../utils/errors.js';
import { tokenLimit } from './tokenLimits.js';
import {
  AuthType,
  ContentGenerator,
  ContentGeneratorConfig,
  createContentGenerator,
} from './contentGenerator.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';

function isThinkingSupported(model: string) {
  if (model.startsWith('gemini-2.5')) return true;
  return false;
}

export class GeminiClient {
  private chat?: GeminiChat;
  private contentGenerator?: ContentGenerator;
  private claudeHistory: Content[] = []; // Separate history for Claude provider
  private embeddingModel: string;
  private generateContentConfig: GenerateContentConfig = {
    temperature: 0,
    topP: 1,
  };
  private readonly MAX_TURNS = 100;
  private readonly TOKEN_THRESHOLD_FOR_SUMMARIZATION = 0.7;

  constructor(private config: Config) {
    if (config.getProxy()) {
      setGlobalDispatcher(new ProxyAgent(config.getProxy() as string));
    }

    this.embeddingModel = config.getEmbeddingModel();
  }

  async initialize(contentGeneratorConfig: ContentGeneratorConfig) {
    this.contentGenerator = await createContentGenerator(
      contentGeneratorConfig,
      this.config.getSessionId(),
    );

    // Only initialize GeminiChat for Gemini provider
    // For Claude, we'll handle chat differently to avoid dual API calls
    if (this.config.getProvider() !== 'claude') {
      this.chat = await this.startChat();
    } else {
      // Initialize Claude history with environment context
      await this.initializeClaudeHistory();
    }
  }

  getContentGenerator(): ContentGenerator {
    if (!this.contentGenerator) {
      throw new Error('Content generator not initialized');
    }
    return this.contentGenerator;
  }

  async addHistory(content: Content) {
    if (this.config.getProvider() === 'claude') {
      this.claudeHistory.push(content);
    } else {
      this.getChat().addHistory(content);
    }
  }

  getChat(): GeminiChat {
    if (!this.chat) {
      if (this.config.getProvider() === 'claude') {
        throw new Error('GeminiChat not available for Claude provider');
      }
      throw new Error('Chat not initialized');
    }
    return this.chat;
  }

  async getHistory(): Promise<Content[]> {
    if (this.config.getProvider() === 'claude') {
      return this.claudeHistory;
    }
    return this.getChat().getHistory();
  }

  async setHistory(history: Content[]): Promise<void> {
    if (this.config.getProvider() === 'claude') {
      this.claudeHistory = [...history];
    } else {
      this.getChat().setHistory(history);
    }
  }

  async resetChat(): Promise<void> {
    if (this.config.getProvider() === 'claude') {
      this.claudeHistory = [];
    } else {
      this.chat = await this.startChat();
    }
  }

  private async getEnvironment(): Promise<Part[]> {
    const cwd = this.config.getWorkingDir();
    const today = new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const platform = process.platform;
    const folderStructure = await getFolderStructure(cwd, {
      fileService: this.config.getFileService(),
    });
    const context = `
  This is the Gemini CLI. We are setting up the context for our chat.
  Today's date is ${today}.
  My operating system is: ${platform}
  I'm currently working in the directory: ${cwd}
  ${folderStructure}
          `.trim();

    const initialParts: Part[] = [{ text: context }];
    const toolRegistry = await this.config.getToolRegistry();

    // Add full file context if the flag is set
    if (this.config.getFullContext()) {
      try {
        const readManyFilesTool = toolRegistry.getTool(
          'read_many_files',
        ) as ReadManyFilesTool;
        if (readManyFilesTool) {
          // Read all files in the target directory
          const result = await readManyFilesTool.execute(
            {
              paths: ['**/*'], // Read everything recursively
              useDefaultExcludes: true, // Use default excludes
            },
            AbortSignal.timeout(30000),
          );
          if (result.llmContent) {
            initialParts.push({
              text: `\n--- Full File Context ---\n${result.llmContent}`,
            });
          } else {
            console.warn(
              'Full context requested, but read_many_files returned no content.',
            );
          }
        } else {
          console.warn(
            'Full context requested, but read_many_files tool not found.',
          );
        }
      } catch (error) {
        // Not using reportError here as it's a startup/config phase, not a chat/generation phase error.
        console.error('Error reading full file context:', error);
        initialParts.push({
          text: '\n--- Error reading full file context ---',
        });
      }
    }

    return initialParts;
  }

  private async startChat(extraHistory?: Content[]): Promise<GeminiChat> {
    const envParts = await this.getEnvironment();
    const toolRegistry = await this.config.getToolRegistry();
    const toolDeclarations = toolRegistry.getFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];
    const history: Content[] = [
      {
        role: 'user',
        parts: envParts,
      },
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the context!' }],
      },
      ...(extraHistory ?? []),
    ];
    try {
      const userMemory = this.config.getUserMemory();
      const systemInstruction = getCoreSystemPrompt(userMemory);
      const generateContentConfigWithThinking = isThinkingSupported(
        this.config.getModel(),
      )
        ? {
            ...this.generateContentConfig,
            thinkingConfig: {
              includeThoughts: true,
            },
          }
        : this.generateContentConfig;
      return new GeminiChat(
        this.config,
        this.getContentGenerator(),
        {
          systemInstruction,
          ...generateContentConfigWithThinking,
          tools,
        },
        history,
      );
    } catch (error) {
      await reportError(
        error,
        'Error initializing Gemini chat session.',
        history,
        'startChat',
      );
      throw new Error(`Failed to initialize chat: ${getErrorMessage(error)}`);
    }
  }

  async *sendMessageStream(
    request: Part | string | Array<string | Part>,
    signal: AbortSignal,
    turns: number = this.MAX_TURNS,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    // If using Claude provider, handle it separately to avoid Gemini-specific code paths
    if (this.config.getProvider() === 'claude') {
      return yield* this.sendClaudeMessageStream(request, signal);
    }

    // Ensure turns never exceeds MAX_TURNS to prevent infinite loops
    const boundedTurns = Math.min(turns, this.MAX_TURNS);
    if (!boundedTurns) {
      return new Turn(this.getChat());
    }

    const compressed = await this.tryCompressChat();
    if (compressed) {
      yield { type: GeminiEventType.ChatCompressed, value: compressed };
    }
    const turn = new Turn(this.getChat());
    const resultStream = turn.run(request, signal);
    for await (const event of resultStream) {
      yield event;
    }
    if (!turn.pendingToolCalls.length && signal && !signal.aborted) {
      // Skip next speaker check for Claude provider as it requires Gemini-specific generateJson
      if (this.config.getProvider() === 'gemini') {
        const nextSpeakerCheck = await checkNextSpeaker(
          this.getChat(),
          this,
          signal,
        );
        if (nextSpeakerCheck?.next_speaker === 'model') {
          const nextRequest = [{ text: 'Please continue.' }];
          // This recursive call's events will be yielded out, but the final
          // turn object will be from the top-level call.
          yield* this.sendMessageStream(nextRequest, signal, boundedTurns - 1);
        }
      }
    }
    return turn;
  }

  private async *sendClaudeMessageStream(
    request: Part | string | Array<string | Part>,
    signal: AbortSignal,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    try {
      // For Claude, we need to handle the entire conversation in one stream
      // because Claude requires tool_use and tool_result to be in consecutive messages
      let currentContents = await this.getHistory();
      const userContent = {
        role: 'user' as const,
        parts: Array.isArray(request)
          ? request.map((part) =>
              typeof part === 'string' ? { text: part } : part,
            )
          : [typeof request === 'string' ? { text: request } : request],
      };

      // Add initial user message to history
      await this.addHistory(userContent);

      // Continue conversation until no more tool calls are needed
      let continueConversation = true;
      let maxTurns = 10; // Prevent infinite loops

      while (continueConversation && maxTurns > 0) {
        maxTurns--;

        // Get current conversation history
        currentContents = await this.getHistory();

        // Get tool declarations for Claude
        const toolRegistry = await this.config.getToolRegistry();
        const toolDeclarations = toolRegistry.getFunctionDeclarations();
        const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];

        // Get system instruction for Claude
        const userMemory = this.config.getUserMemory();
        const systemInstruction = getCoreSystemPrompt(userMemory);

        const generateRequest = {
          model: this.config.getModel(),
          contents: currentContents,
          generationConfig: this.generateContentConfig,
          config: {
            systemInstruction,
            tools,
          },
        };

        const responseStream =
          await this.getContentGenerator().generateContentStream(
            generateRequest,
          );

        let fullResponseText = '';
        let modelResponse: Content | null = null;
        const toolCalls: Array<{
          id: string;
          name: string;
          args: Record<string, unknown>;
        }> = [];

        for await (const response of responseStream) {
          if (signal?.aborted) {
            yield { type: GeminiEventType.UserCancelled };
            return this.createDummyTurn();
          }

          const text = getResponseText(response);
          if (text) {
            fullResponseText += text;
            yield { type: GeminiEventType.Content, value: text };
          }

          // Collect function calls but don't execute them yet
          const functionCalls = response.functionCalls ?? [];
          for (const fnCall of functionCalls) {
            const callId =
              fnCall.id ||
              `${fnCall.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const name = fnCall.name || 'undefined_tool_name';
            const args = (fnCall.args || {}) as Record<string, unknown>;

            toolCalls.push({ id: callId, name, args });

            yield {
              type: GeminiEventType.ToolCallRequest,
              value: {
                callId,
                name,
                args,
                isClientInitiated: false,
              },
            };
          }

          // Prepare model response for history
          if (response.candidates?.[0]?.content && !modelResponse) {
            modelResponse = response.candidates[0].content;
          }
        }

        // Add Claude's response to history (including any tool calls)
        if (fullResponseText || modelResponse || toolCalls.length > 0) {
          const responseParts: Part[] = [];

          // Add text content if present
          if (fullResponseText) {
            responseParts.push({ text: fullResponseText });
          }

          // Add function calls if present
          for (const toolCall of toolCalls) {
            responseParts.push({
              functionCall: {
                name: toolCall.name,
                args: toolCall.args,
                id: toolCall.id,
              },
            });
          }

          const historyContent: Content = {
            role: 'model',
            parts:
              responseParts.length > 0
                ? responseParts
                : [{ text: fullResponseText || 'Assistant response' }],
          };

          await this.addHistory(historyContent);
        }

        // If there are tool calls, execute them and prepare the next message
        if (toolCalls.length > 0) {
          const toolResponseParts: Part[] = [];

          for (const toolCall of toolCalls) {
            try {
              const tool = toolRegistry.getTool(toolCall.name);
              if (tool) {
                const result = await tool.execute(toolCall.args, signal);

                // Add tool result part
                toolResponseParts.push({
                  functionResponse: {
                    name: toolCall.name,
                    response:
                      typeof result.llmContent === 'string'
                        ? { result: result.llmContent }
                        : Array.isArray(result.llmContent) &&
                            result.llmContent.length > 0
                          ? {
                              result: result.llmContent
                                .map((p) =>
                                  typeof p === 'string'
                                    ? p
                                    : (p as { text: string }).text ||
                                      JSON.stringify(p),
                                )
                                .join('\n'),
                            }
                          : { result: 'Tool executed successfully' },
                    toolUseId: toolCall.id,
                  } as unknown as {
                    toolUseId: string;
                  },
                });

                yield {
                  type: GeminiEventType.ToolCallResponse,
                  value: {
                    callId: toolCall.id,
                    responseParts: toolResponseParts,
                    resultDisplay: result.returnDisplay,
                    error: undefined,
                  },
                };
              } else {
                throw new Error(`Tool ${toolCall.name} not found`);
              }
            } catch (toolError) {
              toolResponseParts.push({
                functionResponse: {
                  name: toolCall.name,
                  response: {
                    error:
                      toolError instanceof Error
                        ? toolError.message
                        : String(toolError),
                  },
                  toolUseId: toolCall.id,
                } as unknown as {
                  toolUseId: string;
                },
              });

              yield {
                type: GeminiEventType.ToolCallResponse,
                value: {
                  callId: toolCall.id,
                  responseParts: [],
                  resultDisplay: undefined,
                  error:
                    toolError instanceof Error
                      ? toolError
                      : new Error(String(toolError)),
                },
              };
            }
          }

          // Add tool results as a user message and continue the conversation
          if (toolResponseParts.length > 0) {
            await this.addHistory({
              role: 'user',
              parts: toolResponseParts,
            });
            // Continue the conversation to get Claude's response to the tool results
            continueConversation = true;
          } else {
            continueConversation = false;
          }
        } else {
          // No tool calls, conversation is complete
          continueConversation = false;
        }
      }

      // Return a dummy Turn for type compatibility
      return this.createDummyTurn();
    } catch (error) {
      console.error('Error in Claude message stream:', error);
      yield {
        type: GeminiEventType.Error,
        value: {
          error: {
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
      };
      return this.createDummyTurn();
    }
  }

  private createDummyTurn(): Turn {
    // Create a minimal dummy GeminiChat for type compatibility when using Claude
    const dummyChat = {
      pendingToolCalls: [],
      getHistory: () => Promise.resolve([]),
      async sendMessageStream() {
        // Empty generator for dummy chat
      },
    } as unknown as GeminiChat;

    return new Turn(dummyChat);
  }

  async generateJson(
    contents: Content[],
    schema: SchemaUnion,
    abortSignal: AbortSignal,
    model: string = DEFAULT_GEMINI_FLASH_MODEL,
    config: GenerateContentConfig = {},
  ): Promise<Record<string, unknown>> {
    try {
      const userMemory = this.config.getUserMemory();
      const systemInstruction = getCoreSystemPrompt(userMemory);
      const requestConfig = {
        abortSignal,
        ...this.generateContentConfig,
        ...config,
      };

      const apiCall = () =>
        this.getContentGenerator().generateContent({
          model,
          config: {
            ...requestConfig,
            systemInstruction,
            responseSchema: schema,
            responseMimeType: 'application/json',
          },
          contents,
        });

      const result = await retryWithBackoff(apiCall, {
        onPersistent429: async (authType?: string) =>
          await this.handleFlashFallback(authType),
        authType: this.config.getContentGeneratorConfig()?.authType,
      });

      const text = getResponseText(result);
      if (!text) {
        const error = new Error(
          'API returned an empty response for generateJson.',
        );
        await reportError(
          error,
          'Error in generateJson: API returned an empty response.',
          contents,
          'generateJson-empty-response',
        );
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch (parseError) {
        await reportError(
          parseError,
          'Failed to parse JSON response from generateJson.',
          {
            responseTextFailedToParse: text,
            originalRequestContents: contents,
          },
          'generateJson-parse',
        );
        throw new Error(
          `Failed to parse API response as JSON: ${getErrorMessage(parseError)}`,
        );
      }
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }

      // Avoid double reporting for the empty response case handled above
      if (
        error instanceof Error &&
        error.message === 'API returned an empty response for generateJson.'
      ) {
        throw error;
      }

      await reportError(
        error,
        'Error generating JSON content via API.',
        contents,
        'generateJson-api',
      );
      throw new Error(
        `Failed to generate JSON content: ${getErrorMessage(error)}`,
      );
    }
  }

  async generateContent(
    contents: Content[],
    generationConfig: GenerateContentConfig,
    abortSignal: AbortSignal,
  ): Promise<GenerateContentResponse> {
    const modelToUse = this.config.getModel();
    const configToUse: GenerateContentConfig = {
      ...this.generateContentConfig,
      ...generationConfig,
    };

    try {
      const userMemory = this.config.getUserMemory();
      const systemInstruction = getCoreSystemPrompt(userMemory);

      const requestConfig = {
        abortSignal,
        ...configToUse,
        systemInstruction,
      };

      const apiCall = () =>
        this.getContentGenerator().generateContent({
          model: modelToUse,
          config: requestConfig,
          contents,
        });

      const result = await retryWithBackoff(apiCall, {
        onPersistent429: async (authType?: string) =>
          await this.handleFlashFallback(authType),
        authType: this.config.getContentGeneratorConfig()?.authType,
      });
      return result;
    } catch (error: unknown) {
      if (abortSignal.aborted) {
        throw error;
      }

      await reportError(
        error,
        `Error generating content via API with model ${modelToUse}.`,
        {
          requestContents: contents,
          requestConfig: configToUse,
        },
        'generateContent-api',
      );
      throw new Error(
        `Failed to generate content with model ${modelToUse}: ${getErrorMessage(error)}`,
      );
    }
  }

  async generateEmbedding(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }
    const embedModelParams: EmbedContentParameters = {
      model: this.embeddingModel,
      contents: texts,
    };

    const embedContentResponse =
      await this.getContentGenerator().embedContent(embedModelParams);
    if (
      !embedContentResponse.embeddings ||
      embedContentResponse.embeddings.length === 0
    ) {
      throw new Error('No embeddings found in API response.');
    }

    if (embedContentResponse.embeddings.length !== texts.length) {
      throw new Error(
        `API returned a mismatched number of embeddings. Expected ${texts.length}, got ${embedContentResponse.embeddings.length}.`,
      );
    }

    return embedContentResponse.embeddings.map((embedding, index) => {
      const values = embedding.values;
      if (!values || values.length === 0) {
        throw new Error(
          `API returned an empty embedding for input text at index ${index}: "${texts[index]}"`,
        );
      }
      return values;
    });
  }

  async tryCompressChat(
    force: boolean = false,
  ): Promise<ChatCompressionInfo | null> {
    const curatedHistory = this.getChat().getHistory(true);

    // Regardless of `force`, don't do anything if the history is empty.
    if (curatedHistory.length === 0) {
      return null;
    }

    const model = this.config.getModel();

    let { totalTokens: originalTokenCount } =
      await this.getContentGenerator().countTokens({
        model,
        contents: curatedHistory,
      });
    if (originalTokenCount === undefined) {
      console.warn(`Could not determine token count for model ${model}.`);
      originalTokenCount = 0;
    }

    // Don't compress if not forced and we are under the limit.
    if (
      !force &&
      originalTokenCount <
        this.TOKEN_THRESHOLD_FOR_SUMMARIZATION * tokenLimit(model)
    ) {
      return null;
    }

    const { text: summary } = await this.getChat().sendMessage({
      message: {
        text: 'First, reason in your scratchpad. Then, generate the <state_snapshot>.',
      },
      config: {
        systemInstruction: { text: getCompressionPrompt() },
      },
    });
    this.chat = await this.startChat([
      {
        role: 'user',
        parts: [{ text: summary }],
      },
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the additional context!' }],
      },
    ]);

    const { totalTokens: newTokenCount } =
      await this.getContentGenerator().countTokens({
        // model might change after calling `sendMessage`, so we get the newest value from config
        model: this.config.getModel(),
        contents: this.getChat().getHistory(),
      });
    if (newTokenCount === undefined) {
      console.warn('Could not determine compressed history token count.');
      return null;
    }

    return {
      originalTokenCount,
      newTokenCount,
    };
  }

  /**
   * Handles fallback to Flash model when persistent 429 errors occur for OAuth users.
   * Uses a fallback handler if provided by the config, otherwise returns null.
   */
  private async handleFlashFallback(authType?: string): Promise<string | null> {
    // Only handle fallback for OAuth users
    if (authType !== AuthType.LOGIN_WITH_GOOGLE) {
      return null;
    }

    const currentModel = this.config.getModel();
    const fallbackModel = DEFAULT_GEMINI_FLASH_MODEL;

    // Don't fallback if already using Flash model
    if (currentModel === fallbackModel) {
      return null;
    }

    // Check if config has a fallback handler (set by CLI package)
    const fallbackHandler = this.config.flashFallbackHandler;
    if (typeof fallbackHandler === 'function') {
      try {
        const accepted = await fallbackHandler(currentModel, fallbackModel);
        if (accepted) {
          this.config.setModel(fallbackModel);
          return fallbackModel;
        }
      } catch (error) {
        console.warn('Flash fallback handler failed:', error);
      }
    }

    return null;
  }

  private async initializeClaudeHistory(): Promise<void> {
    // Initialize Claude history with environment context similar to GeminiChat
    // but avoid re-loading memory since it's already loaded by CLI
    const cwd = this.config.getWorkingDir();
    const today = new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const platform = process.platform;

    // Use already-loaded memory instead of re-scanning
    const userMemory = this.config.getUserMemory();
    const context = `
This is the Gemini CLI. We are setting up the context for our chat.
Today's date is ${today}.
My operating system is: ${platform}
I'm currently working in the directory: ${cwd}

${userMemory}
    `.trim();

    const envParts = [{ text: context }];

    this.claudeHistory = [
      {
        role: 'user',
        parts: envParts,
      },
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the context!' }],
      },
    ];
  }
}
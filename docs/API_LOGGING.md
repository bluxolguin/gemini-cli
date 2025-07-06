# API Logging and Provider Selection

This document describes the comprehensive API logging system and provider selection logic implemented in the Gemini CLI.

## API Logging System

The Gemini CLI includes detailed logging for all API interactions with both Gemini and Claude providers. This helps with debugging, monitoring API usage, and understanding the conversation flow.

### Features

- **Comprehensive Logging**: Logs all requests, responses, streaming chunks, and errors
- **Provider-Specific Markers**: Visual indicators (🟢 Gemini, 🔵 Claude, 🔴 Error) for easy identification
- **Configurable Verbosity**: Control log detail level via environment variable
- **Safe Content Logging**: Truncates long content to prevent log overflow
- **Error Context**: Detailed error information including stack traces when available

### Configuration

Set the `GEMINI_LOG_LEVEL` environment variable to control logging verbosity:

- `NONE`: No API logging (default)
- `ERROR`: Only log API errors
- `BASIC`: Log basic request/response info
- `DETAILED`: Include response content and usage metadata
- `VERBOSE`: Maximum detail including function calls and parameters

### Examples

```bash
# Enable basic logging
export GEMINI_LOG_LEVEL="BASIC"
gemini "Hello, world!"

# Enable detailed logging
export GEMINI_LOG_LEVEL="DETAILED"
gemini --provider claude "Explain TypeScript"

# Enable verbose logging
export GEMINI_LOG_LEVEL="VERBOSE"
gemini "Help me debug this code"
```

### Log Output Format

#### Gemini Request (🟢)

```
🟢 Gemini Request: gemini-2.5-pro (2 contents)
   Role: user, Parts: 1 text part(s)
```

#### Gemini Response (🟢)

```
🟢 Gemini Response: gemini-2.5-pro (1.2s)
   Usage: 45 prompt + 123 completion = 168 total tokens
```

#### Claude Request (🔵)

```
🔵 Claude Request: claude-3-sonnet-20240229
   System: You are a helpful assistant...
   Messages: 1 user message(s)
```

#### Error (🔴)

```
🔴 Gemini Error: gemini-2.5-pro (0.5s)
   Type: AuthenticationError
   Message: Invalid API key provided
```

## Provider Selection Logic

The CLI has been enhanced with robust provider selection logic that ensures the correct AI provider is used based on available API keys and user preferences.

### Default Behavior

1. **No Provider Specified**: Defaults to Gemini
2. **No API Keys**: Falls back to Gemini OAuth (interactive login)
3. **Invalid Configuration**: Gracefully falls back to working configuration

### Provider Selection Priority

1. **Explicit Provider + API Key**: If `--provider claude` is specified and `CLAUDE_API_KEY` exists, use Claude
2. **API Key Availability**: If only one provider's API key is available, use that provider
3. **Fallback to Gemini**: If Claude is requested but no Claude API key exists, fall back to Gemini
4. **OAuth Fallback**: If no API keys are available, use Gemini OAuth

### Configuration Methods

#### Environment Variables

```bash
# Set provider preference
export AI_PROVIDER="claude"  # or "gemini"

# Set API keys
export GEMINI_API_KEY="your-gemini-key"
export CLAUDE_API_KEY="your-claude-key"
```

#### Command Line

```bash
# Explicitly specify provider
gemini --provider claude "Your prompt"
gemini --provider gemini "Your prompt"
```

#### Settings File (`.gemini/settings.json`)

```json
{
  "provider": "claude",
  "selectedAuthType": "claude-api-key"
}
```

### Error Prevention

The enhanced provider selection logic prevents common errors:

- ✅ **No more "Claude streaming error: Could not resolve authentication method"**
- ✅ **Automatic fallback when requested provider isn't available**
- ✅ **Clear warnings when falling back to different provider**
- ✅ **Graceful handling of missing API keys**

### Examples

```bash
# Use Claude with API key
export CLAUDE_API_KEY="your-key"
gemini --provider claude "Hello"

# Fallback: Claude requested but no API key, uses Gemini
unset CLAUDE_API_KEY
export GEMINI_API_KEY="your-key"
gemini --provider claude "Hello"  # Falls back to Gemini with warning

# Default: No provider specified, uses Gemini
gemini "Hello"  # Uses Gemini (OAuth if no API key)
```

## Implementation Details

The logging and provider selection improvements are implemented across several files:

- `packages/core/src/utils/apiLogger.ts`: Centralized logging utility
- `packages/core/src/core/geminiChat.ts`: Gemini API logging integration
- `packages/core/src/claude/claudeClient.ts`: Claude API logging integration
- `packages/core/src/config/config.ts`: Enhanced provider selection logic
- `packages/cli/src/config/config.ts`: CLI-level provider validation
- `packages/cli/src/gemini.tsx`: Authentication validation improvements

## Troubleshooting

### Common Issues

1. **"Claude streaming error"**: Ensure `CLAUDE_API_KEY` is set if using Claude
2. **"Invalid auth method"**: Check that the required API key exists for your selected provider
3. **No logs appearing**: Verify `GEMINI_LOG_LEVEL` is set to a value other than `NONE`

### Debug Mode

Enable debug mode to see detailed provider selection logic:

```bash
gemini --debug "Your prompt"
```

This will show:

- Which provider is selected
- Whether API keys are detected
- Authentication method being used
- Any fallback behavior triggered

# Run with verbose logging to see all stream chunks

GEMINI_LOG_LEVEL=VERBOSE gemini

```

## Log Format

### Gemini Logs
- 🟢 Gemini requests and responses
- 🔴 Gemini errors

### Claude Logs
- 🔵 Claude requests and responses
- 🔴 Claude errors

## Examples

### Basic Level Output
```

🟢 GEMINI REQUEST: Model: gemini-2.5-pro, Contents: 3
🟢 GEMINI RESPONSE: Model: gemini-2.5-pro, Duration: 1250ms, Usage: {"promptTokenCount":150,"candidatesTokenCount":85}

````

### Detailed Level Output
```json
🟢 GEMINI REQUEST: {
  "model": "gemini-2.5-pro",
  "contentCount": 3,
  "contents": [
    {
      "role": "user",
      "parts": [{"type": "text", "text": "Hello, how can you help me..."}]
    }
  ],
  "generationConfig": {"temperature": 0, "topP": 1}
}
````

### Verbose Level Output

Includes all the above plus individual stream chunks:

```json
🟢 GEMINI STREAM CHUNK 1: {
  "valid": true,
  "candidates": [{"role": "model", "parts": [{"type": "text", "text": "I can help..."}]}]
}
```

## Integration

The logging system is automatically integrated into:

- `GeminiChat.sendMessage()` - Non-streaming requests
- `GeminiChat.sendMessageStream()` - Streaming requests
- `ClaudeContentGenerator.generateContent()` - Claude requests
- `ClaudeContentGenerator.generateContentStream()` - Claude streaming

All logs respect the configured log level and provide appropriate detail for debugging and monitoring API usage.

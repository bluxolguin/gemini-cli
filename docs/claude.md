# Claude Integration

This document describes how to use Claude as an AI provider with the Gemini CLI.

## Setup

### 1. Get a Claude API Key

1. Visit [Anthropic's Console](https://console.anthropic.com/)
2. Sign up or log in to your account
3. Navigate to the API Keys section
4. Create a new API key

### 2. Configure the CLI

You can use Claude in several ways:

#### Option 1: Environment Variable
Set the `CLAUDE_API_KEY` environment variable:

```bash
export CLAUDE_API_KEY="your-claude-api-key-here"
```

#### Option 2: Command Line Flag
Use the `--provider` flag when running the CLI:

```bash
gemini --provider claude
```

#### Option 3: Settings File
Add the provider setting to your `.gemini/settings.json` file:

```json
{
  "provider": "claude"
}
```

### 3. Environment Variables

- **`CLAUDE_API_KEY`** (Required): Your Anthropic Claude API key
- **`AI_PROVIDER`**: Default provider to use ('gemini' or 'claude')

## Model Mapping

The CLI automatically maps Gemini model names to equivalent Claude models:

| Gemini Model | Claude Model |
|--------------|--------------|
| `gemini-2.5-pro` | `claude-3-opus-20240229` |
| `gemini-2.5-flash` | `claude-3-sonnet-20240229` |
| `gemini-pro` | `claude-3-sonnet-20240229` |
| `gemini-flash` | `claude-3-haiku-20240307` |

You can also specify Claude models directly:

```bash
gemini --provider claude --model claude-3-opus-20240229
```

## Usage Examples

### Basic Usage

```bash
# Use Claude with default model
export CLAUDE_API_KEY="your-api-key"
gemini --provider claude

# Use Claude with specific model
gemini --provider claude --model claude-3-opus-20240229

# Use Claude with prompt
gemini --provider claude -p "Explain how to use TypeScript generics"
```

### Settings Configuration

Create or edit `.gemini/settings.json` in your project or home directory:

```json
{
  "provider": "claude",
  "selectedAuthType": "claude-api-key"
}
```

## Limitations

1. **Embeddings**: Claude doesn't provide embeddings. Consider using OpenAI or Google embeddings for this functionality.
2. **Token Counting**: Token counting is estimated since Claude doesn't provide a direct token counting API.
3. **Streaming**: Full streaming support is implemented but may have slight differences from Gemini's streaming format.

## Authentication Types

When using Claude, the CLI will automatically set the authentication type to `claude-api-key`. Available auth types:

- `claude-api-key`: Use Claude with API key authentication
- `gemini-api-key`: Use Gemini with API key authentication  
- `oauth-personal`: Use Gemini with Google OAuth (Code Assist)
- `vertex-ai`: Use Gemini via Vertex AI

## Troubleshooting

### Common Issues

1. **Invalid API Key**: Make sure your `CLAUDE_API_KEY` is correctly set and valid
2. **Rate Limits**: Claude has rate limits that vary by plan
3. **Model Availability**: Some Claude models may not be available in all regions

### Error Messages

- `Claude API error: Invalid API key`: Check your API key configuration
- `Claude does not support embeddings`: Use a different provider for embedding functionality
- `Claude streaming error`: Check your network connection and API key

## Example .env File

```bash
# Claude Configuration
CLAUDE_API_KEY=your-claude-api-key-here
AI_PROVIDER=claude

# Optional: Override default model
GEMINI_MODEL=claude-3-opus-20240229
```

## Cost Considerations

Claude pricing varies by model and usage. Check [Anthropic's pricing page](https://docs.anthropic.com/claude/docs/models-overview#model-comparison) for current rates:

- Claude 3 Haiku: Lower cost, faster responses
- Claude 3 Sonnet: Balanced performance and cost
- Claude 3 Opus: Highest performance, highest cost

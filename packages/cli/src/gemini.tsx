/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink';
import { AppWrapper } from './ui/App.js';
import { loadCliConfig } from './config/config.js';
import { readStdin } from './utils/readStdin.js';
import { basename } from 'node:path';
import v8 from 'node:v8';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { start_sandbox } from './utils/sandbox.js';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import {
  LoadedSettings,
  loadSettings,
  SettingScope,
  USER_SETTINGS_PATH,
} from './config/settings.js';
import { themeManager } from './ui/themes/theme-manager.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import { loadExtensions, Extension } from './config/extension.js';
import { cleanupCheckpoints } from './utils/cleanup.js';
import {
  ApprovalMode,
  Config,
  EditTool,
  ShellTool,
  WriteFileTool,
  sessionId,
  logUserPrompt,
  AuthType,
} from '@google/gemini-cli-core';
import { validateAuthMethod } from './config/auth.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';

function getNodeMemoryArgs(config: Config): string[] {
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  // Set target to 50% of total memory
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (config.getDebugMode()) {
    console.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env.GEMINI_CLI_NO_RELAUNCH) {
    return [];
  }

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (config.getDebugMode()) {
      console.debug(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }

  return [];
}

async function relaunchWithAdditionalArgs(additionalArgs: string[]) {
  const nodeArgs = [...additionalArgs, ...process.argv.slice(1)];
  const newEnv = { ...process.env, GEMINI_CLI_NO_RELAUNCH: 'true' };

  const child = spawn(process.execPath, nodeArgs, {
    stdio: 'inherit',
    env: newEnv,
  });

  await new Promise((resolve) => child.on('close', resolve));
  process.exit(0);
}

export async function main() {
  console.log('[DEBUG] MAIN FUNCTION - Starting main function');
  const workspaceRoot = process.cwd();
  console.log('[DEBUG] MAIN FUNCTION - Workspace root:', workspaceRoot);
  const settings = loadSettings(workspaceRoot);
  console.log(
    '[DEBUG] MAIN FUNCTION - Settings loaded, selectedAuthType:',
    settings.merged.selectedAuthType,
  );

  // Auto-configure selectedAuthType based on provider and available API keys
  // This must happen BEFORE any React components initialize
  // Explicit provider overrides existing settings
  const argv = yargs(hideBin(process.argv)).parseSync();
  const provider =
    argv.provider ||
    settings.merged.provider ||
    process.env.AI_PROVIDER ||
    'gemini';

  console.log('[DEBUG] Early auth config - Provider:', provider);
  console.log(
    '[DEBUG] Early auth config - Claude API Key present:',
    !!process.env.CLAUDE_API_KEY,
  );
  console.log(
    '[DEBUG] Early auth config - Current selectedAuthType:',
    settings.merged.selectedAuthType,
  );
  console.log(
    '[DEBUG] Early auth config - Explicit provider from CLI:',
    argv.provider,
  );

  const hasExistingAuth = settings.merged.selectedAuthType;
  const isExplicitProviderOverride = !!argv.provider;

  // Override auth type if:
  // 1. No existing auth type, OR
  // 2. User explicitly specified a provider via CLI, OR
  // 3. Existing auth type doesn't match current provider
  const needsAuthUpdate =
    !hasExistingAuth ||
    isExplicitProviderOverride ||
    (hasExistingAuth &&
      ((provider === 'claude' &&
        settings.merged.selectedAuthType !== AuthType.USE_CLAUDE) ||
        (provider === 'gemini' &&
          settings.merged.selectedAuthType === AuthType.USE_CLAUDE)));

  if (needsAuthUpdate) {
    if (provider === 'claude' && process.env.CLAUDE_API_KEY) {
      console.log(
        '[DEBUG] Setting selectedAuthType to USE_CLAUDE' +
          (isExplicitProviderOverride ? ' (explicit override)' : ''),
      );
      settings.setValue(
        SettingScope.User,
        'selectedAuthType',
        AuthType.USE_CLAUDE,
      );
    } else if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      console.log(
        '[DEBUG] Setting selectedAuthType to USE_GEMINI' +
          (isExplicitProviderOverride ? ' (explicit override)' : ''),
      );
      settings.setValue(
        SettingScope.User,
        'selectedAuthType',
        AuthType.USE_GEMINI,
      );
    } else if (provider === 'claude' && !process.env.CLAUDE_API_KEY) {
      if (isExplicitProviderOverride) {
        console.error(
          '[ERROR] You explicitly requested --provider claude but no CLAUDE_API_KEY environment variable is set.',
        );
        console.error(
          'Please set CLAUDE_API_KEY=your_api_key_here or remove the --provider claude flag.',
        );
        process.exit(1);
      } else {
        console.log(
          '[DEBUG] Claude requested but no CLAUDE_API_KEY found, keeping existing auth',
        );
      }
    } else if (provider === 'gemini' && !process.env.GEMINI_API_KEY) {
      // For Gemini, we can fall back to OAuth if no API key is present
      console.log('[DEBUG] Gemini provider, falling back to OAuth');
      settings.setValue(
        SettingScope.User,
        'selectedAuthType',
        AuthType.LOGIN_WITH_GOOGLE,
      );
    }
  } else {
    console.log(
      '[DEBUG] Respecting existing auth type:',
      settings.merged.selectedAuthType,
    );
  }

  console.log(
    '[DEBUG] Final early selectedAuthType:',
    settings.merged.selectedAuthType,
  );

  await cleanupCheckpoints();
  if (settings.errors.length > 0) {
    for (const error of settings.errors) {
      let errorMessage = `Error in ${error.path}: ${error.message}`;
      if (!process.env.NO_COLOR) {
        errorMessage = `\x1b[31m${errorMessage}\x1b[0m`;
      }
      console.error(errorMessage);
      console.error(`Please fix ${error.path} and try again.`);
    }
    process.exit(1);
  }

  const extensions = loadExtensions(workspaceRoot);
  const config = await loadCliConfig(settings.merged, extensions, sessionId);

  // set default fallback to appropriate API key based on provider
  // this has to go after load cli because that's where the env is set
  // Only set if no auth type is configured
  if (!settings.merged.selectedAuthType) {
    const provider = config.getProvider();
    if (provider === 'claude' && process.env.CLAUDE_API_KEY) {
      settings.setValue(
        SettingScope.User,
        'selectedAuthType',
        AuthType.USE_CLAUDE,
      );
      // Force refresh auth with Claude
      await config.refreshAuth(AuthType.USE_CLAUDE);
    } else if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      settings.setValue(
        SettingScope.User,
        'selectedAuthType',
        AuthType.USE_GEMINI,
      );
    }
  } else {
    console.log(
      '[DEBUG] Using existing selectedAuthType:',
      settings.merged.selectedAuthType,
    );
  }

  setMaxSizedBoxDebugging(config.getDebugMode());

  // Initialize centralized FileDiscoveryService
  config.getFileService();
  if (config.getCheckpointingEnabled()) {
    try {
      await config.getGitService();
    } catch {
      // For now swallow the error, later log it.
    }
  }

  if (settings.merged.theme) {
    if (!themeManager.setActiveTheme(settings.merged.theme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in App.tsx will handle opening the dialog.
      console.warn(`Warning: Theme "${settings.merged.theme}" not found.`);
    }
  }

  const memoryArgs = settings.merged.autoConfigureMaxOldSpaceSize
    ? getNodeMemoryArgs(config)
    : [];

  // hop into sandbox if we are outside and sandboxing is enabled
  if (!process.env.SANDBOX) {
    const sandboxConfig = config.getSandbox();
    if (sandboxConfig) {
      if (settings.merged.selectedAuthType) {
        // Validate authentication here because the sandbox will interfere with the Oauth2 web redirect.
        try {
          const err = validateAuthMethod(settings.merged.selectedAuthType);
          if (err) {
            throw new Error(err);
          }
          await config.refreshAuth(settings.merged.selectedAuthType);
        } catch (err) {
          console.error('Error authenticating:', err);
          process.exit(1);
        }
      }
      await start_sandbox(sandboxConfig, memoryArgs);
      process.exit(0);
    } else {
      // Not in a sandbox and not entering one, so relaunch with additional
      // arguments to control memory usage if needed.
      if (memoryArgs.length > 0) {
        await relaunchWithAdditionalArgs(memoryArgs);
        process.exit(0);
      }
    }
  }
  let input = config.getQuestion();
  const startupWarnings = await getStartupWarnings();

  // Render UI, passing necessary config values. Check that there is no command line question.
  if (process.stdin.isTTY && input?.length === 0) {
    setWindowTitle(basename(workspaceRoot), settings);
    render(
      <React.StrictMode>
        <AppWrapper
          config={config}
          settings={settings}
          startupWarnings={startupWarnings}
        />
      </React.StrictMode>,
      { exitOnCtrlC: false },
    );
    return;
  }
  // If not a TTY, read from stdin
  // This is for cases where the user pipes input directly into the command
  if (!process.stdin.isTTY && !input) {
    input += await readStdin();
  }
  if (!input) {
    console.error('No input provided via stdin.');
    process.exit(1);
  }

  logUserPrompt(config, {
    'event.name': 'user_prompt',
    'event.timestamp': new Date().toISOString(),
    prompt: input,
    prompt_length: input.length,
  });

  // Non-interactive mode handled by runNonInteractive
  const nonInteractiveConfig = await loadNonInteractiveConfig(
    config,
    extensions,
    settings,
  );

  await runNonInteractive(nonInteractiveConfig, input);
  process.exit(0);
}

function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.hideWindowTitle) {
    process.stdout.write(`\x1b]2; Gemini - ${title} \x07`);

    process.on('exit', () => {
      process.stdout.write(`\x1b]2;\x07`);
    });
  }
}

// --- Global Unhandled Rejection Handler ---
process.on('unhandledRejection', (reason, _promise) => {
  // Log other unexpected unhandled rejections as critical errors
  console.error('=========================================');
  console.error('CRITICAL: Unhandled Promise Rejection!');
  console.error('=========================================');
  console.error('Reason:', reason);
  console.error('Stack trace may follow:');
  if (!(reason instanceof Error)) {
    console.error(reason);
  }
  // Exit for genuinely unhandled errors
  process.exit(1);
});

async function loadNonInteractiveConfig(
  config: Config,
  extensions: Extension[],
  settings: LoadedSettings,
) {
  let finalConfig = config;
  if (config.getApprovalMode() !== ApprovalMode.YOLO) {
    // Everything is not allowed, ensure that only read-only tools are configured.
    const existingExcludeTools = settings.merged.excludeTools || [];
    const interactiveTools = [
      ShellTool.Name,
      EditTool.Name,
      WriteFileTool.Name,
    ];

    const newExcludeTools = [
      ...new Set([...existingExcludeTools, ...interactiveTools]),
    ];

    const nonInteractiveSettings = {
      ...settings.merged,
      excludeTools: newExcludeTools,
    };
    finalConfig = await loadCliConfig(
      nonInteractiveSettings,
      extensions,
      config.getSessionId(),
    );
  }

  return await validateNonInterActiveAuth(
    settings.merged.selectedAuthType,
    finalConfig,
  );
}

async function validateNonInterActiveAuth(
  selectedAuthType: AuthType | undefined,
  nonInteractiveConfig: Config,
) {
  // If no authType is set, determine it from provider and available API keys
  if (!selectedAuthType) {
    const provider = nonInteractiveConfig.getProvider();
    if (provider === 'claude' && process.env.CLAUDE_API_KEY) {
      selectedAuthType = AuthType.USE_CLAUDE;
    } else if (process.env.GEMINI_API_KEY) {
      selectedAuthType = AuthType.USE_GEMINI;
    } else {
      console.error(
        `Please set an Auth method in your ${USER_SETTINGS_PATH} OR specify GEMINI_API_KEY env variable before running`,
      );
      process.exit(1);
    }
  }

  const err = validateAuthMethod(selectedAuthType);
  if (err != null) {
    console.error(err);
    process.exit(1);
  }

  await nonInteractiveConfig.refreshAuth(selectedAuthType);
  return nonInteractiveConfig;
}

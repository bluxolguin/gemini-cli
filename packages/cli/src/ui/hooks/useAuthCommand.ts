/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import process from 'node:process';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import {
  AuthType,
  Config,
  clearCachedCredentialFile,
  getErrorMessage,
} from '@google/gemini-cli-core';

// Helper function to check if auth should be auto-configured
const shouldAutoConfigureAuth = (settings: LoadedSettings): boolean => {
  // If selectedAuthType is already set, don't auto-configure
  if (settings.merged.selectedAuthType) {
    return false;
  }

  // Check if we have the necessary environment variables for auto-configuration
  const provider = settings.merged.provider || process.env.AI_PROVIDER || 'gemini';
  
  if (provider === 'claude' && process.env.CLAUDE_API_KEY) {
    return true;
  }
  
  if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
    return true;
  }
  
  return false;
};

// Helper function to check if we should show auth dialog
const shouldShowAuthDialog = (settings: LoadedSettings): boolean => {
  // If selectedAuthType is defined, no need for dialog
  if (settings.merged.selectedAuthType) {
    return false;
  }

  // If we can auto-configure, no need for dialog
  if (shouldAutoConfigureAuth(settings)) {
    return false;
  }

  // Otherwise, show the dialog
  return true;
};

export const useAuthCommand = (
  settings: LoadedSettings,
  setAuthError: (error: string | null) => void,
  config: Config,
) => {
  // Use the helper function to determine if dialog should be shown
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(
    shouldShowAuthDialog(settings),
  );

  // Watch for changes in settings and update dialog state accordingly
  useEffect(() => {
    const shouldShow = shouldShowAuthDialog(settings);
    setIsAuthDialogOpen(shouldShow);
  }, [settings.merged.selectedAuthType, settings.merged.provider]);

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    const authFlow = async () => {
      const authType = settings.merged.selectedAuthType;
      if (isAuthDialogOpen || !authType) {
        return;
      }

      try {
        setIsAuthenticating(true);
        await config.refreshAuth(authType);
        console.log(`Authenticated via "${authType}".`);
      } catch (e) {
        setAuthError(`Failed to login. Message: ${getErrorMessage(e)}`);
        openAuthDialog();
      } finally {
        setIsAuthenticating(false);
      }
    };

    void authFlow();
  }, [isAuthDialogOpen, settings, config, setAuthError, openAuthDialog]);

  const handleAuthSelect = useCallback(
    async (authType: AuthType | undefined, scope: SettingScope) => {
      if (authType) {
        await clearCachedCredentialFile();
        settings.setValue(scope, 'selectedAuthType', authType);
      }
      setIsAuthDialogOpen(false);
      setAuthError(null);
    },
    [settings, setAuthError],
  );

  const cancelAuthentication = useCallback(() => {
    setIsAuthenticating(false);
  }, []);

  return {
    isAuthDialogOpen,
    openAuthDialog,
    handleAuthSelect,
    isAuthenticating,
    cancelAuthentication,
  };
};

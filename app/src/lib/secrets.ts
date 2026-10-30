// API keys and passwords live in the OS secret store (Windows Credential Manager,
// macOS Keychain, Linux Secret Service) via the Rust `keyring` crate, never in
// the settings file.
import { invoke } from '@tauri-apps/api/core';

export type SecretName = 'soniox_api_key' | 'elevenlabs_api_key' | 'obs_password';

// Resolves to null when nothing is stored.
export function getSecret(name: SecretName): Promise<string | null> {
  return invoke('secret_get', { name });
}

export function setSecret(name: SecretName, value: string): Promise<void> {
  return invoke('secret_set', { name, value });
}

export function deleteSecret(name: SecretName): Promise<void> {
  return invoke('secret_delete', { name });
}

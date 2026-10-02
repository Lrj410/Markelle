import { invoke } from "@tauri-apps/api/core";

/** Absolute paths of `*.md` under `{vault}/.markelle/templates/`. */
export async function listVaultTemplates(vaultRoot: string): Promise<string[]> {
  return invoke<string[]>("list_vault_templates", { vaultRoot });
}
